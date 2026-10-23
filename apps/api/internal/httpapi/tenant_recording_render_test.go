package httpapi

import (
	"context"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"net/http"
	"testing"
)

type renderSettingMembership struct{ role memberships.Role }

func (m renderSettingMembership) GetTenantMembershipForUser(context.Context, utilities.ID, utilities.ID) (memberships.Membership, error) {
	return memberships.Membership{Role: m.role}, nil
}

func TestTenantRecordingRenderPermission(t *testing.T) {
	id := mustTestID(t, "00000000-0000-4000-8000-000000000001")
	serviceID := "dashboard"
	for _, tc := range []struct {
		name      string
		principal authentication.Principal
		role      memberships.Role
		status    int
	}{
		{"observer", authentication.Principal{Kind: authentication.PrincipalUser, UserID: id}, memberships.RoleObserver, http.StatusForbidden},
		{"collaborator", authentication.Principal{Kind: authentication.PrincipalUser, UserID: id}, memberships.RoleCollaborator, http.StatusOK},
		{"owner", authentication.Principal{Kind: authentication.PrincipalUser, UserID: id}, memberships.RoleOwner, http.StatusOK},
		{"read-only key", authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: id, TenantID: id}, "", http.StatusForbidden},
		{"owning service", authentication.Principal{Kind: authentication.PrincipalService, ServiceID: serviceID, Scopes: []authentication.Scope{authentication.ScopeTenantsWrite}}, "", http.StatusOK},
		{"foreign service", authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "foreign", Scopes: []authentication.Scope{authentication.ScopeTenantsWrite}}, "", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &rateLimitTenantRepository{values: map[utilities.ID]tenants.Tenant{id: {ID: id, CreatedByServiceID: &serviceID}}}
			service := tenants.NewService(repo)
			policy := authorization.NewTenantPolicy(renderSettingMembership{tc.role}, repo)
			response := serveAccountEndpoint(updateTenantEndpoint(service, policy), tc.principal, http.MethodPatch, "/tenants/"+id.String(), `{"recording_render_mode":"automatic"}`)
			if response.Code != tc.status {
				t.Fatalf("status=%d want=%d: %s", response.Code, tc.status, response.Body.String())
			}
			if tc.status == http.StatusForbidden && repo.writes != 0 {
				t.Fatal("rejected caller changed tenant settings")
			}
		})
	}
}
