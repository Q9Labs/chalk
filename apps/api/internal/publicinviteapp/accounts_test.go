package publicinviteapp_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAccountsPortAllowsTenantMemberAfterInviteResolution(t *testing.T) {
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	tenantID := mustID(t, "22222222-2222-4222-8222-222222222222")
	authorizer := &tenantAuthorizerStub{}
	accounts, err := publicinviteapp.NewAccountsPort(authorizer)
	if err != nil {
		t.Fatal(err)
	}

	ok, err := accounts.AuthorizePublicAccount(context.Background(), accountID, tenantID)
	if err != nil || !ok {
		t.Fatalf("authorization = %v, %v", ok, err)
	}
	if authorizer.principal.Kind != authentication.PrincipalUser || authorizer.principal.UserID != accountID || authorizer.tenantID != tenantID || authorizer.permission.MinimumRole != memberships.RoleCollaborator {
		t.Fatalf("authorization input = %#v / %#v / %#v", authorizer.principal, authorizer.tenantID, authorizer.permission)
	}
}

func TestAccountsPortFallsBackToGuestForMissingOrForbidden(t *testing.T) {
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	tenantID := mustID(t, "22222222-2222-4222-8222-222222222222")
	for _, authErr := range []error{authorization.ErrUnauthenticated, authorization.ErrForbidden} {
		authorizer := &tenantAuthorizerStub{err: authErr}
		accounts, err := publicinviteapp.NewAccountsPort(authorizer)
		if err != nil {
			t.Fatal(err)
		}
		ok, err := accounts.AuthorizePublicAccount(context.Background(), accountID, tenantID)
		if err != nil || ok {
			t.Fatalf("authorization for %v = %v, %v", authErr, ok, err)
		}
	}
}

func TestAccountsPortPropagatesOperationalErrors(t *testing.T) {
	backendErr := errors.New("membership backend unavailable")
	accounts, err := publicinviteapp.NewAccountsPort(&tenantAuthorizerStub{err: backendErr})
	if err != nil {
		t.Fatal(err)
	}
	ok, err := accounts.AuthorizePublicAccount(context.Background(), mustID(t, "11111111-1111-4111-8111-111111111111"), mustID(t, "22222222-2222-4222-8222-222222222222"))
	if ok || !errors.Is(err, backendErr) {
		t.Fatalf("authorization = %v, %v", ok, err)
	}
}

type tenantAuthorizerStub struct {
	principal  authentication.Principal
	tenantID   utilities.ID
	permission authorization.TenantPermission
	err        error
}

func (s *tenantAuthorizerStub) AuthorizeTenant(_ context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error {
	s.principal = principal
	s.tenantID = tenantID
	s.permission = permission
	return s.err
}
