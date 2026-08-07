package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeDiagnosticsAccountTenantServiceStub struct {
	list func(context.Context, utilities.ID, pagination.PageRequest) (tenants.AccountTenantList, error)
}

func (s episodeDiagnosticsAccountTenantServiceStub) ListAccountTenants(ctx context.Context, accountID utilities.ID, page pagination.PageRequest) (tenants.AccountTenantList, error) {
	return s.list(ctx, accountID, page)
}

func (episodeDiagnosticsAccountTenantServiceStub) OnboardTenant(context.Context, tenants.OnboardTenantInput) (tenants.OnboardTenantResult, error) {
	return tenants.OnboardTenantResult{}, errors.New("unexpected tenant onboarding call")
}

type episodeDiagnosticsTenantAuthorizerStub struct {
	authorize func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error
}

func (s episodeDiagnosticsTenantAuthorizerStub) AuthorizeTenant(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error {
	return s.authorize(ctx, principal, tenantID, permission)
}

func TestEpisodeDiagnosticsAccountAuthorizerUsesAccountAndTenantPolicy(t *testing.T) {
	accountID := mustDiagnosticID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	allowedTenantID := mustDiagnosticID(t, "11111111-1111-4111-8111-111111111111")
	crossAccountTenantID := mustDiagnosticID(t, "22222222-2222-4222-8222-222222222222")
	deniedTenantID := mustDiagnosticID(t, "33333333-3333-4333-8333-333333333333")
	var authorizeCalls []utilities.ID
	authorizer := NewEpisodeDiagnosticsAccountAuthorizer(
		episodeDiagnosticsAccountTenantServiceStub{list: func(_ context.Context, gotAccountID utilities.ID, page pagination.PageRequest) (tenants.AccountTenantList, error) {
			if gotAccountID != accountID || page.Size() != pagination.MaxPageSize {
				t.Fatalf("account tenant query = account %s page %d", gotAccountID, page.Size())
			}
			return tenants.AccountTenantList{Tenants: []tenants.AccountTenant{
				{Access: tenants.TenantAccess{AccountID: accountID, TenantID: allowedTenantID, Role: memberships.RoleOwner}},
				{Access: tenants.TenantAccess{AccountID: crossAccountTenantID, TenantID: crossAccountTenantID, Role: memberships.RoleOwner}},
				{Access: tenants.TenantAccess{AccountID: accountID, TenantID: deniedTenantID, Role: memberships.RoleObserver}},
			}, Page: pagination.Page{PageSize: pagination.MaxPageSize}}, nil
		}},
		episodeDiagnosticsTenantAuthorizerStub{authorize: func(_ context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error {
			if principal.UserID != accountID || permission.MinimumRole != memberships.RoleObserver {
				t.Fatalf("tenant policy input = principal %#v permission %#v", principal, permission)
			}
			authorizeCalls = append(authorizeCalls, tenantID)
			if tenantID == deniedTenantID {
				return authorization.ErrForbidden
			}
			return nil
		}},
	)
	scope, err := authorizer.AuthorizeEpisodeDiagnosticsAccount(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: accountID})
	if err != nil {
		t.Fatalf("authorize account: %v", err)
	}
	wantHashBytes := sha256.Sum256([]byte(accountID.String()))
	if scope.SubjectHash != hex.EncodeToString(wantHashBytes[:]) {
		t.Fatalf("subject hash = %q, want hash of account id", scope.SubjectHash)
	}
	if len(scope.AuthorizedTenantIDs) != 1 || scope.AuthorizedTenantIDs[0] != allowedTenantID.String() {
		t.Fatalf("authorized tenant ids = %#v", scope.AuthorizedTenantIDs)
	}
	for _, capability := range []string{"read", "stream", "export"} {
		if _, ok := scope.Capabilities[capability]; !ok {
			t.Fatalf("missing capability %q in %#v", capability, scope.Capabilities)
		}
	}
	if len(authorizeCalls) != 2 || authorizeCalls[0] != allowedTenantID || authorizeCalls[1] != deniedTenantID {
		t.Fatalf("tenant policy calls = %#v", authorizeCalls)
	}
}

func TestEpisodeDiagnosticsAccountAuthorizerRejectsEmptyTenantScope(t *testing.T) {
	accountID := mustDiagnosticID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	authorizer := NewEpisodeDiagnosticsAccountAuthorizer(
		episodeDiagnosticsAccountTenantServiceStub{list: func(context.Context, utilities.ID, pagination.PageRequest) (tenants.AccountTenantList, error) {
			return tenants.AccountTenantList{Page: pagination.Page{PageSize: pagination.MaxPageSize}}, nil
		}},
		episodeDiagnosticsTenantAuthorizerStub{authorize: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
			return nil
		}},
	)
	_, err := authorizer.AuthorizeEpisodeDiagnosticsAccount(context.Background(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: accountID})
	if !errors.Is(err, authorization.ErrForbidden) {
		t.Fatalf("error = %v, want forbidden", err)
	}
}

func TestEpisodeDiagnosticsAccountAuthorizerRejectsInvalidPrincipal(t *testing.T) {
	authorizer := NewEpisodeDiagnosticsAccountAuthorizer(nil, nil)
	_, err := authorizer.AuthorizeEpisodeDiagnosticsAccount(context.Background(), authentication.Principal{Kind: authentication.PrincipalAPIKey})
	if !errors.Is(err, authorization.ErrUnauthenticated) {
		t.Fatalf("error = %v, want unauthenticated", err)
	}
}
