package authorization_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTenantPolicyAllowsAPIKeyWithTenantScope(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	apiKeyID := mustID(t, "22222222-2222-2222-2222-222222222222")
	policy := authorization.NewTenantPolicy(nil)

	err := policy.AuthorizeTenant(context.Background(), authentication.Principal{
		Kind:     authentication.PrincipalAPIKey,
		TenantID: tenantID,
		APIKeyID: apiKeyID,
		Scopes:   []authentication.Scope{authentication.ScopeRoomsWrite},
	}, tenantID, authorization.TenantPermission{
		Scope: authentication.ScopeRoomsWrite,
	})
	if err != nil {
		t.Fatalf("authorize tenant: %v", err)
	}
}

func TestTenantPolicyRejectsAPIKeyWithoutScope(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	apiKeyID := mustID(t, "22222222-2222-2222-2222-222222222222")
	policy := authorization.NewTenantPolicy(nil)

	err := policy.AuthorizeTenant(context.Background(), authentication.Principal{
		Kind:     authentication.PrincipalAPIKey,
		TenantID: tenantID,
		APIKeyID: apiKeyID,
		Scopes:   []authentication.Scope{authentication.ScopeRoomsRead},
	}, tenantID, authorization.TenantPermission{
		Scope: authentication.ScopeRoomsWrite,
	})
	if !errors.Is(err, authorization.ErrForbidden) {
		t.Fatalf("error = %v, want forbidden", err)
	}
}

func TestTenantPolicyRejectsAPIKeyForDifferentTenant(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	otherTenantID := mustID(t, "33333333-3333-3333-3333-333333333333")
	apiKeyID := mustID(t, "22222222-2222-2222-2222-222222222222")
	policy := authorization.NewTenantPolicy(nil)

	err := policy.AuthorizeTenant(context.Background(), authentication.Principal{
		Kind:     authentication.PrincipalAPIKey,
		TenantID: otherTenantID,
		APIKeyID: apiKeyID,
		Scopes:   []authentication.Scope{authentication.ScopeRoomsWrite},
	}, tenantID, authorization.TenantPermission{
		Scope: authentication.ScopeRoomsWrite,
	})
	if !errors.Is(err, authorization.ErrForbidden) {
		t.Fatalf("error = %v, want forbidden", err)
	}
}

func TestTenantPolicyAllowsUserWithEnoughRole(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	userID := mustID(t, "22222222-2222-2222-2222-222222222222")
	reader := &membershipReader{role: memberships.RoleAdmin}
	policy := authorization.NewTenantPolicy(reader)

	err := policy.AuthorizeTenant(context.Background(), authentication.Principal{
		Kind:   authentication.PrincipalUser,
		UserID: userID,
	}, tenantID, authorization.TenantPermission{
		MinimumRole: memberships.RoleMember,
	})
	if err != nil {
		t.Fatalf("authorize tenant: %v", err)
	}
	if reader.tenantID.String() != tenantID.String() {
		t.Fatalf("tenant id = %q, want %q", reader.tenantID.String(), tenantID.String())
	}
	if reader.userID.String() != userID.String() {
		t.Fatalf("user id = %q, want %q", reader.userID.String(), userID.String())
	}
}

func TestTenantPolicyRejectsUserWithWeakRole(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	userID := mustID(t, "22222222-2222-2222-2222-222222222222")
	policy := authorization.NewTenantPolicy(&membershipReader{role: memberships.RoleViewer})

	err := policy.AuthorizeTenant(context.Background(), authentication.Principal{
		Kind:   authentication.PrincipalUser,
		UserID: userID,
	}, tenantID, authorization.TenantPermission{
		MinimumRole: memberships.RoleAdmin,
	})
	if !errors.Is(err, authorization.ErrForbidden) {
		t.Fatalf("error = %v, want forbidden", err)
	}
}

func TestTenantPolicyAllowsSystemPrincipal(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	policy := authorization.NewTenantPolicy(nil)

	err := policy.AuthorizeTenant(context.Background(), authentication.Principal{
		Kind: authentication.PrincipalSystem,
	}, tenantID, authorization.TenantPermission{
		Scope:       authentication.ScopeTenantsDelete,
		MinimumRole: memberships.RoleOwner,
	})
	if err != nil {
		t.Fatalf("authorize tenant: %v", err)
	}
}

func TestRoleAllows(t *testing.T) {
	if !authorization.RoleAllows(memberships.RoleOwner, memberships.RoleViewer) {
		t.Fatal("owner should allow viewer permission")
	}
	if authorization.RoleAllows(memberships.RoleMember, memberships.RoleAdmin) {
		t.Fatal("member should not allow admin permission")
	}
	if authorization.RoleAllows(memberships.RoleAdmin, "") {
		t.Fatal("empty minimum role should not be allowed")
	}
}

type membershipReader struct {
	role     memberships.Role
	err      error
	tenantID utilities.ID
	userID   utilities.ID
}

func (r *membershipReader) GetTenantMembershipForUser(ctx context.Context, tenantID utilities.ID, userID utilities.ID) (memberships.Membership, error) {
	r.tenantID = tenantID
	r.userID = userID
	if r.err != nil {
		return memberships.Membership{}, r.err
	}

	return memberships.Membership{
		TenantID: tenantID,
		UserID:   userID,
		Role:     r.role,
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
