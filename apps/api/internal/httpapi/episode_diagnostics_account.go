package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
)

// NewEpisodeDiagnosticsAccountAuthorizer adapts the existing Dashboard
// account/tenant services to the diagnostics gateway contract. It deliberately
// lists only the authenticated account's tenant access records and re-checks
// every record through the normal TenantPolicy before returning a bounded,
// canonical allowlist.
func NewEpisodeDiagnosticsAccountAuthorizer(accountTenants AccountTenantService, tenantAuthz TenantAuthorizer) EpisodeDiagnosticsAccountAuthorizer {
	return episodeDiagnosticsAccountAuthorizer{accountTenants: accountTenants, tenantAuthz: tenantAuthz}
}

type episodeDiagnosticsAccountAuthorizer struct {
	accountTenants AccountTenantService
	tenantAuthz    TenantAuthorizer
}

func (a episodeDiagnosticsAccountAuthorizer) AuthorizeEpisodeDiagnosticsAccount(ctx context.Context, principal authentication.Principal) (EpisodeDiagnosticsAccountScope, error) {
	if principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
		return EpisodeDiagnosticsAccountScope{}, authorization.ErrUnauthenticated
	}
	if a.accountTenants == nil || a.tenantAuthz == nil {
		return EpisodeDiagnosticsAccountScope{}, errors.New("episode diagnostics account authorization is unavailable")
	}

	page, err := pagination.NewPageRequest(pagination.MaxPageSize, nil)
	if err != nil {
		return EpisodeDiagnosticsAccountScope{}, fmt.Errorf("create account tenant page: %w", err)
	}
	allowed := make([]string, 0, episodediagnostics.MaxOperatorTenantIDs)
	seen := make(map[string]struct{}, episodediagnostics.MaxOperatorTenantIDs)
	for {
		list, listErr := a.accountTenants.ListAccountTenants(ctx, principal.UserID, page)
		if listErr != nil {
			return EpisodeDiagnosticsAccountScope{}, fmt.Errorf("list account tenants for diagnostics: %w", listErr)
		}
		for _, accountTenant := range list.Tenants {
			access := accountTenant.Access
			if access.AccountID != principal.UserID || access.TenantID.IsZero() {
				continue
			}
			if err := a.tenantAuthz.AuthorizeTenant(ctx, principal, access.TenantID, authorization.TenantPermission{MinimumRole: memberships.RoleObserver}); err != nil {
				if errors.Is(err, authorization.ErrForbidden) {
					continue
				}
				return EpisodeDiagnosticsAccountScope{}, fmt.Errorf("authorize diagnostics tenant %s: %w", access.TenantID, err)
			}

			tenantID := access.TenantID.String()
			if _, exists := seen[tenantID]; exists {
				continue
			}
			if len(allowed) >= episodediagnostics.MaxOperatorTenantIDs {
				return EpisodeDiagnosticsAccountScope{}, authorization.ErrForbidden
			}
			seen[tenantID] = struct{}{}
			allowed = append(allowed, tenantID)
		}

		if !list.Page.HasMore {
			break
		}
		if list.Page.NextCursor == nil {
			return EpisodeDiagnosticsAccountScope{}, errors.New("account tenant page omitted its next cursor")
		}
		page, err = pagination.NewPageRequest(pagination.MaxPageSize, list.Page.NextCursor)
		if err != nil {
			return EpisodeDiagnosticsAccountScope{}, fmt.Errorf("create next account tenant page: %w", err)
		}
	}
	if len(allowed) == 0 {
		return EpisodeDiagnosticsAccountScope{}, authorization.ErrForbidden
	}

	digest := sha256.Sum256([]byte(principal.UserID.String()))
	return EpisodeDiagnosticsAccountScope{
		SubjectHash:         hex.EncodeToString(digest[:]),
		AuthorizedTenantIDs: allowed,
		Capabilities: map[string]struct{}{
			"read":   {},
			"stream": {},
			"export": {},
		},
	}, nil
}

var _ EpisodeDiagnosticsAccountAuthorizer = episodeDiagnosticsAccountAuthorizer{}
