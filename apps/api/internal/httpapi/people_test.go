package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type peopleRoleReader struct{ role memberships.Role }

func (r peopleRoleReader) GetTenantMembershipForUser(context.Context, utilities.ID, utilities.ID) (memberships.Membership, error) {
	return memberships.Membership{Role: r.role}, nil
}
func TestPeopleRoleDenial(t *testing.T) {
	tenant := "11111111-1111-4111-8111-111111111111"
	id := "22222222-2222-4222-8222-222222222222"
	account, err := utilities.ParseID(id)
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []memberships.Role{memberships.RoleObserver, memberships.RoleCollaborator} {
		t.Run(string(role), func(t *testing.T) {
			policy := authorization.NewTenantPolicy(peopleRoleReader{role: role})
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					next.ServeHTTP(w, r.WithContext(authentication.ContextWithPrincipal(r.Context(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: account})))
				})
			})
			people := memberships.NewPeopleService(nil, nil, "", "")
			for _, endpoint := range peopleEndpoints(people, policy) {
				endpoint.Mount(router, RateLimitOptions{})
			}
			mountMembershipRoutes(router, memberships.NewService(nil), policy, RateLimitOptions{})
			for _, request := range []struct{ method, path, body string }{
				{"POST", "/tenants/" + tenant + "/invitations", `{"email":"new@example.test","role":"observer"}`},
				{"GET", "/tenants/" + tenant + "/invitations", ""},
				{"DELETE", "/tenants/" + tenant + "/invitations/" + id, ""},
				{"DELETE", "/tenants/" + tenant + "/memberships/" + id, ""},
				{"PATCH", "/tenants/" + tenant + "/memberships/" + id, `{"role":"owner"}`},
			} {
				response := httptest.NewRecorder()
				router.ServeHTTP(response, httptest.NewRequest(request.method, request.path, strings.NewReader(request.body)))
				if response.Code != 403 || !strings.Contains(response.Body.String(), "access.forbidden") {
					t.Fatalf("%s %s status=%d body=%s", request.method, request.path, response.Code, response.Body.String())
				}
			}
		})
	}
}
func TestPeopleActionableErrors(t *testing.T) {
	for _, entry := range []struct {
		err     error
		status  int
		message string
	}{
		{memberships.ErrInvitationUnavailable, 410, "new invitation"},
		{memberships.ErrInvitationAccount, 403, "invited email"},
		{memberships.ErrLastOwner, 409, "another Owner"},
	} {
		mapped, ok := peopleAPIError(entry.err)
		if !ok || mapped.Status != entry.status || !strings.Contains(mapped.Message, entry.message) {
			t.Fatalf("mapped=%v ok=%v", mapped, ok)
		}
	}
}

func TestMembershipResponseIncludesUserIdentity(t *testing.T) {
	response := newMembershipResponse(memberships.Membership{
		UserName:  "Alex Smith",
		UserEmail: "alex@example.test",
	})

	if response.UserName != "Alex Smith" || response.UserEmail != "alex@example.test" {
		t.Fatalf("response identity = %q, %q", response.UserName, response.UserEmail)
	}
}
