package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTenantInvitationLifecycleAndOwnerProtection(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := context.Background()
	tenant, owner, account, other := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
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
	if _, err = membershipService.UpdateTenantMembership(ctx, tenant, accepted.ID, memberships.UpdateMembershipInput{Role: memberships.RoleOwner}); err != nil {
		t.Fatal(err)
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
