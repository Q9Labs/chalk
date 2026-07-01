package authorization

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrUnauthenticated = errors.New("unauthenticated")
	ErrForbidden       = errors.New("forbidden")
	ErrInvalidTenantID = errors.New("invalid tenant id")
)

type TenantMembershipReader interface {
	GetTenantMembershipForUser(ctx context.Context, tenantID utilities.ID, userID utilities.ID) (memberships.Membership, error)
}

type TenantPolicy struct {
	memberships TenantMembershipReader
}

type TenantPermission struct {
	Scope       authentication.Scope
	MinimumRole memberships.Role
}

func NewTenantPolicy(memberships TenantMembershipReader) TenantPolicy {
	return TenantPolicy{memberships: memberships}
}

func (p TenantPolicy) AuthorizeTenant(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission TenantPermission) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if !principal.IsAuthenticated() {
		return ErrUnauthenticated
	}

	switch principal.Kind {
	case authentication.PrincipalKindSystem:
		return nil
	case authentication.PrincipalKindAPIKey:
		return authorizeTenantAPIKey(principal, tenantID, permission.Scope)
	case authentication.PrincipalKindUser:
		return p.authorizeTenantUser(ctx, principal, tenantID, permission.MinimumRole)
	default:
		return ErrUnauthenticated
	}
}

func authorizeTenantAPIKey(principal authentication.Principal, tenantID utilities.ID, scope authentication.Scope) error {
	if principal.APIKeyID.IsZero() || principal.TenantID.IsZero() {
		return ErrUnauthenticated
	}
	if principal.TenantID.String() != tenantID.String() {
		return ErrForbidden
	}
	if !principal.HasScope(scope) {
		return ErrForbidden
	}

	return nil
}

func (p TenantPolicy) authorizeTenantUser(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, minimumRole memberships.Role) error {
	if principal.UserID.IsZero() {
		return ErrUnauthenticated
	}
	if p.memberships == nil {
		return ErrForbidden
	}

	membership, err := p.memberships.GetTenantMembershipForUser(ctx, tenantID, principal.UserID)
	if errors.Is(err, memberships.ErrMembershipNotFound) {
		return ErrForbidden
	}
	if err != nil {
		return fmt.Errorf("get tenant membership: %w", err)
	}
	if !RoleAllows(membership.Role, minimumRole) {
		return ErrForbidden
	}

	return nil
}

func RoleAllows(actual memberships.Role, minimum memberships.Role) bool {
	return roleRank(actual) >= roleRank(minimum) && roleRank(minimum) > 0
}

func roleRank(role memberships.Role) int {
	switch role {
	case memberships.RoleOwner:
		return 4
	case memberships.RoleAdmin:
		return 3
	case memberships.RoleMember:
		return 2
	case memberships.RoleViewer:
		return 1
	default:
		return 0
	}
}
