package postgres

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTenantInvitationLifecycleAndOwnerProtection(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := context.Background()
	tenant, owner, account, other := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	journeyID := accountTenantIntegrationID(t)
	ctx = observability.ContextWithJourneyID(ctx, journeyID)
	address := account.String() + "@invitation.test"
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Invitation test')`, uuid(tenant)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []utilities.ID{owner, account, other} {
		if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,'Invitation account',$2)`, uuid(id), id.String()+"@invitation.test"); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from observability_journey_events where journey_id=$1`, uuid(journeyID))
		pool.Exec(ctx, `delete from tenant_invitations where tenant_id=$1`, uuid(tenant))
		pool.Exec(ctx, `delete from memberships where tenant_id=$1`, uuid(tenant))
		pool.Exec(ctx, `delete from tenants where id=$1`, uuid(tenant))
		pool.Exec(ctx, `delete from users where id in ($1,$2,$3)`, uuid(owner), uuid(account), uuid(other))
	})
	repository := NewPeopleRepository(pool)
	service := memberships.NewPeopleService(repository, nil, "", "https://chalk.test")
	membershipRepo := NewMembershipRepository(sqlc.New(pool), pool)
	membershipService := memberships.NewService(membershipRepo)
	ownerMembership, err := membershipService.CreateMembership(ctx, memberships.CreateMembershipInput{TenantID: tenant, UserID: owner, Role: memberships.RoleOwner})
	if err != nil {
		t.Fatal(err)
	}
	if ownerMembership.UserName != "Invitation account" || ownerMembership.UserEmail != owner.String()+"@invitation.test" {
		t.Fatalf("created membership identity=%q %q", ownerMembership.UserName, ownerMembership.UserEmail)
	}
	listed, err := membershipService.ListTenantMemberships(ctx, tenant, pagination.PageRequest{})
	if err != nil || len(listed.Memberships) != 1 || listed.Memberships[0].UserName != "Invitation account" || listed.Memberships[0].UserEmail != owner.String()+"@invitation.test" {
		t.Fatalf("listed membership=%v err=%v", listed.Memberships, err)
	}
	issue := func(role memberships.Role) memberships.InvitationResult {
		t.Helper()
		result, err := service.IssueInvitation(ctx, tenant, "  "+strings.ToUpper(address)+"  ", role)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	token := func(result memberships.InvitationResult) string {
		t.Helper()
		_, secret, ok := strings.Cut(result.AcceptLink, "#token=")
		if !ok {
			t.Fatal("missing fragment token")
		}
		return secret
	}
	expectUnavailable := func(result memberships.InvitationResult) {
		t.Helper()
		_, err := service.AcceptInvitation(ctx, token(result), account)
		if !errors.Is(err, memberships.ErrInvitationUnavailable) {
			t.Fatalf("unavailable error = %v", err)
		}
	}
	first := issue(memberships.RoleObserver)
	replacement := issue(memberships.RoleCollaborator)
	if first.Invitation.ID == replacement.Invitation.ID {
		t.Fatal("replacement must invalidate old invitation")
	}
	expectUnavailable(first)
	pending, err := service.ListInvitations(ctx, tenant)
	if err != nil || len(pending) != 1 || pending[0].ID != replacement.Invitation.ID {
		t.Fatalf("pending=%v err=%v", pending, err)
	}
	if _, err = service.AcceptInvitation(ctx, token(replacement), other); !errors.Is(err, memberships.ErrInvitationAccount) {
		t.Fatalf("wrong account = %v", err)
	}
	accepted, err := service.AcceptInvitation(ctx, token(replacement), account)
	if err != nil || accepted.Role != memberships.RoleCollaborator || accepted.UserID != account {
		t.Fatalf("accepted=%v err=%v", accepted, err)
	}
	expectUnavailable(replacement)
	var acceptedEvents int
	var evidence string
	if err = pool.QueryRow(ctx, `select count(*),coalesce(string_agg(attributes::text,''),'') from observability_journey_events where journey_id=$1 and name='tenant.invitation.accepted'`, uuid(journeyID)).Scan(&acceptedEvents, &evidence); err != nil || acceptedEvents != 1 {
		t.Fatalf("accepted journey events=%d err=%v", acceptedEvents, err)
	}
	if strings.Contains(evidence, token(replacement)) {
		t.Fatal("journey evidence leaked an invitation token")
	}
	pending, err = service.ListInvitations(ctx, tenant)
	if err != nil || len(pending) != 0 {
		t.Fatalf("consumed pending=%v err=%v", pending, err)
	}
	revoked := issue(memberships.RoleObserver)
	if err = service.RevokeInvitation(ctx, tenant, revoked.Invitation.ID); err != nil {
		t.Fatal(err)
	}
	expectUnavailable(revoked)
	expired := issue(memberships.RoleObserver)
	if _, err = pool.Exec(ctx, `update tenant_invitations set expires_at=clock_timestamp()-interval '1 second' where id=$1`, uuid(expired.Invitation.ID)); err != nil {
		t.Fatal(err)
	}
	expectUnavailable(expired)
	pending, err = service.ListInvitations(ctx, tenant)
	if err != nil || len(pending) != 0 {
		t.Fatalf("expired pending=%v err=%v", pending, err)
	}
	// Existing membership acceptance preserves the Role, including an Owner.
	updated, err := membershipService.UpdateTenantMembership(ctx, tenant, accepted.ID, memberships.UpdateMembershipInput{Role: memberships.RoleOwner})
	if err != nil {
		t.Fatal(err)
	}
	if updated.UserName != "Invitation account" || updated.UserEmail != account.String()+"@invitation.test" {
		t.Fatalf("updated membership identity=%q %q", updated.UserName, updated.UserEmail)
	}
	existing := issue(memberships.RoleObserver)
	preserved, err := service.AcceptInvitation(ctx, token(existing), account)
	if err != nil || preserved.Role != memberships.RoleOwner {
		t.Fatalf("existing Owner=%v err=%v", preserved, err)
	}
	if err = service.RemoveMembership(ctx, other, accepted.ID); !errors.Is(err, memberships.ErrMembershipNotFound) && err == nil {
		t.Fatal("cross Tenant removal succeeded")
	}
	// Two concurrent departures must leave one Owner, even when both start together.
	start := make(chan struct{})
	results := make(chan error, 2)
	var group sync.WaitGroup
	for _, id := range []utilities.ID{owner, account} {
		group.Add(1)
		go func(id utilities.ID) { defer group.Done(); <-start; results <- service.LeaveTenant(ctx, tenant, id) }(id)
	}
	close(start)
	group.Wait()
	close(results)
	success, protected := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, memberships.ErrLastOwner) {
			protected++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || protected != 1 {
		t.Fatalf("departures success=%d protected=%d", success, protected)
	}
	var remaining utilities.ID
	if _, err = membershipRepo.GetTenantMembershipForUser(ctx, tenant, owner); err == nil {
		remaining = ownerMembership.ID
	} else {
		remaining = accepted.ID
	}
	if err = service.RemoveMembership(ctx, tenant, remaining); !errors.Is(err, memberships.ErrLastOwner) {
		t.Fatalf("remove last Owner=%v", err)
	}
	if _, err = membershipService.UpdateTenantMembership(ctx, tenant, remaining, memberships.UpdateMembershipInput{Role: memberships.RoleObserver}); !errors.Is(err, memberships.ErrLastOwner) {
		t.Fatalf("demote last Owner=%v", err)
	}
	// Normal member removal and leaving are allowed.
	member, err := membershipService.CreateMembership(ctx, memberships.CreateMembershipInput{TenantID: tenant, UserID: other, Role: memberships.RoleObserver})
	if err != nil {
		t.Fatal(err)
	}
	if err = service.RemoveMembership(ctx, tenant, member.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = membershipRepo.GetTenantMembershipForUser(ctx, tenant, other); !errors.Is(err, memberships.ErrMembershipNotFound) {
		t.Fatalf("removed member=%v", err)
	}
	if _, err = membershipService.CreateMembership(ctx, memberships.CreateMembershipInput{TenantID: tenant, UserID: other, Role: memberships.RoleObserver}); err != nil {
		t.Fatal(err)
	}
	if err = service.LeaveTenant(ctx, tenant, other); err != nil {
		t.Fatal(err)
	}
}

func TestOnboardedTenantCreatorCanLeaveOrBeRemoved(t *testing.T) {
	for _, action := range []string{"leave", "remove"} {
		t.Run(action, func(t *testing.T) {
			pool := accountTenantIntegrationPool(t)
			ctx := context.Background()
			creator, secondOwner := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
			for _, id := range []utilities.ID{creator, secondOwner} {
				if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,'Onboarded creator',$2)`, uuid(id), id.String()+"@invitation.test"); err != nil {
					t.Fatal(err)
				}
			}
			onboarding := tenants.NewAccountService(NewAccountTenantRepository(sqlc.New(pool), pool, nil))
			input := tenants.OnboardTenantInput{AccountID: creator, RequestKey: "creator-removal-regression-0001", Name: "Creator removal test"}
			onboarded, err := onboarding.OnboardTenant(ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			tenant := onboarded.AccountTenant.Tenant.ID
			t.Cleanup(func() {
				pool.Exec(ctx, `delete from tenant_onboarding_requests where tenant_id=$1`, uuid(tenant))
				pool.Exec(ctx, `delete from memberships where tenant_id=$1`, uuid(tenant))
				pool.Exec(ctx, `delete from tenants where id=$1`, uuid(tenant))
				pool.Exec(ctx, `delete from users where id in ($1,$2)`, uuid(creator), uuid(secondOwner))
			})
			var operationLog bytes.Buffer
			decorate := func(queries sqlc.Querier) sqlc.Querier {
				return observability.OperationQueries(queries, slog.New(slog.NewJSONHandler(&operationLog, nil)))
			}
			membershipService := memberships.NewService(NewMembershipRepository(sqlc.New(pool), pool, decorate))
			if _, err = membershipService.CreateMembership(ctx, memberships.CreateMembershipInput{TenantID: tenant, UserID: secondOwner, Role: memberships.RoleOwner}); err != nil {
				t.Fatal(err)
			}
			if _, err = membershipService.UpdateTenantMembership(ctx, tenant, onboarded.AccountTenant.Access.ID, memberships.UpdateMembershipInput{Role: memberships.RoleOwner}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(operationLog.String(), `"name":"UpdateTenantMembership"`) || !strings.Contains(operationLog.String(), `"outcome":"ok"`) {
				t.Fatal("successful Role update lost query telemetry")
			}
			if _, err = membershipService.UpdateTenantMembership(ctx, tenant, accountTenantIntegrationID(t), memberships.UpdateMembershipInput{Role: memberships.RoleOwner}); !errors.Is(err, memberships.ErrMembershipNotFound) {
				t.Fatalf("missing membership update=%v", err)
			}
			if !strings.Contains(operationLog.String(), `"outcome":"error"`) {
				t.Fatal("failed Role update lost query telemetry")
			}
			people := memberships.NewPeopleService(NewPeopleRepository(pool), nil, "", "https://chalk.test")
			if action == "leave" {
				err = people.LeaveTenant(ctx, tenant, creator)
			} else {
				err = people.RemoveMembership(ctx, tenant, onboarded.AccountTenant.Access.ID)
			}
			if err != nil {
				t.Fatalf("onboarded creator %s: %v", action, err)
			}
			var history int
			if err = pool.QueryRow(ctx, `select count(*) from tenant_onboarding_requests where tenant_id=$1`, uuid(tenant)).Scan(&history); err != nil || history != 1 {
				t.Fatalf("history=%d err=%v", history, err)
			}
			if _, err = onboarding.OnboardTenant(ctx, input); !errors.Is(err, tenants.ErrTenantNotFound) {
				t.Fatalf("removed creator replay should not regain access: %v", err)
			}
			var count int
			if err = pool.QueryRow(ctx, `select count(*) from memberships where tenant_id=$1`, uuid(tenant)).Scan(&count); err != nil || count != 1 {
				t.Fatalf("membership count=%d err=%v", count, err)
			}
			invitation, err := people.IssueInvitation(ctx, tenant, creator.String()+"@invitation.test", memberships.RoleObserver)
			if err != nil {
				t.Fatal(err)
			}
			_, token, _ := strings.Cut(invitation.AcceptLink, "#token=")
			if _, err = people.AcceptInvitation(ctx, token, creator); err != nil {
				t.Fatal(err)
			}
			replay, err := onboarding.OnboardTenant(ctx, input)
			if err != nil || !replay.Replayed || replay.AccountTenant.Access.Role != memberships.RoleObserver {
				t.Fatalf("rejoined creator replay=%v err=%v", replay, err)
			}

		})
	}
}
