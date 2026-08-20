package publicinviteapp

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type tenantAuthorizer interface {
	AuthorizeTenant(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error
}

var ErrAccountsPortUnavailable = errors.New("public Accounts adapter unavailable")

// NewAccountsPort adapts the existing Tenant authorization policy to the
// public-invites account port. The Runtime calls this only after cspi1 has
// resolved the target Tenant, so the account never selects the Tenant.
func NewAccountsPort(authorizer tenantAuthorizer) (publicinvites.Accounts, error) {
	if authorizer == nil {
		return nil, ErrAccountsPortUnavailable
	}
	return accountsPort{authorizer: authorizer}, nil
}

type accountsPort struct {
	authorizer tenantAuthorizer
}

func (a accountsPort) AuthorizePublicAccount(ctx context.Context, accountID, tenantID utilities.ID) (bool, error) {
	if accountID.IsZero() || tenantID.IsZero() {
		return false, nil
	}

	err := a.authorizer.AuthorizeTenant(ctx, authentication.Principal{
		Kind:   authentication.PrincipalUser,
		UserID: accountID,
	}, tenantID, authorization.TenantPermission{MinimumRole: memberships.RoleCollaborator})
	if err == nil {
		return true, nil
	}
	if errors.Is(err, authorization.ErrUnauthenticated) || errors.Is(err, authorization.ErrForbidden) {
		return false, nil
	}
	return false, err
}

var _ publicinvites.Accounts = accountsPort{}
