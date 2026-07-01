package memberships_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestServiceCreateMembership(t *testing.T) {
	repository := &membershipRepository{}
	service := memberships.NewService(repository)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	userID := mustID(t, "22222222-2222-2222-2222-222222222222")

	membership, err := service.CreateMembership(context.Background(), memberships.CreateMembershipInput{
		TenantID: tenantID,
		UserID:   userID,
		Role:     memberships.RoleAdmin,
	})
	if err != nil {
		t.Fatalf("create membership: %v", err)
	}

	if membership.ID.IsZero() {
		t.Fatal("membership id was not generated")
	}
	if repository.createInput.TenantID.String() != tenantID.String() {
		t.Fatalf("tenant id = %q, want %q", repository.createInput.TenantID.String(), tenantID.String())
	}
	if repository.createInput.Role != memberships.RoleAdmin {
		t.Fatalf("role = %q, want admin", repository.createInput.Role)
	}
}

func TestServiceCreateMembershipRejectsInvalidRole(t *testing.T) {
	repository := &membershipRepository{}
	service := memberships.NewService(repository)

	_, err := service.CreateMembership(context.Background(), memberships.CreateMembershipInput{
		TenantID: mustID(t, "11111111-1111-1111-1111-111111111111"),
		UserID:   mustID(t, "22222222-2222-2222-2222-222222222222"),
		Role:     "superadmin",
	})
	if !errors.Is(err, memberships.ErrInvalidMembershipRole) {
		t.Fatalf("error = %v, want %v", err, memberships.ErrInvalidMembershipRole)
	}
	if repository.called {
		t.Fatal("repository was called")
	}
}

func TestServiceUpdateMembershipRejectsZeroMembershipID(t *testing.T) {
	repository := &membershipRepository{}
	service := memberships.NewService(repository)

	_, err := service.UpdateTenantMembership(context.Background(), mustID(t, "11111111-1111-1111-1111-111111111111"), utilities.ID{}, memberships.UpdateMembershipInput{
		Role: memberships.RoleMember,
	})
	if !errors.Is(err, memberships.ErrInvalidMembershipID) {
		t.Fatalf("error = %v, want %v", err, memberships.ErrInvalidMembershipID)
	}
	if repository.called {
		t.Fatal("repository was called")
	}
}

type membershipRepository struct {
	called       bool
	createInput  memberships.CreateMembershipInput
	updateInput  memberships.UpdateMembershipInput
	tenantID     utilities.ID
	membershipID utilities.ID
	page         pagination.PageRequest
	err          error
}

func (r *membershipRepository) CreateMembership(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error) {
	r.called = true
	r.createInput = input
	if r.err != nil {
		return memberships.Membership{}, r.err
	}

	return memberships.Membership{
		ID:       input.ID,
		TenantID: input.TenantID,
		UserID:   input.UserID,
		Role:     input.Role,
	}, nil
}

func (r *membershipRepository) ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error) {
	r.called = true
	r.tenantID = tenantID
	r.page = page
	if r.err != nil {
		return memberships.MembershipList{}, r.err
	}

	return memberships.MembershipList{
		Page: pagination.Page{PageSize: page.Size()},
	}, nil
}

func (r *membershipRepository) UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error) {
	r.called = true
	r.tenantID = tenantID
	r.membershipID = membershipID
	r.updateInput = input
	if r.err != nil {
		return memberships.Membership{}, r.err
	}

	return memberships.Membership{
		ID:       membershipID,
		TenantID: tenantID,
		Role:     input.Role,
	}, nil
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}

	return id
}
