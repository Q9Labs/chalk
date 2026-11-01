package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestServiceTranscriptLanguageBoundary(t *testing.T) {
	for _, value := range []string{"auto", "ur", "ar", "en"} {
		request := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(`{"transcript_language":"`+value+`"}`))
		request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalService}))
		body, err := decodeUpdateTenantBody(request)
		if err != nil || !body.TranscriptLanguage.Set || body.TranscriptLanguage.Value == nil || body.TranscriptLanguage.Value.String() != value {
			t.Fatalf("service language %s: %+v %v", value, body.TranscriptLanguage, err)
		}
	}
	id := mustTestID(t, "00000000-0000-4000-8000-000000000001")
	owner := "dashboard"
	for _, test := range []struct {
		name, serviceID, body string
		status                int
	}{
		{"owner", owner, `{"transcript_language":"ur"}`, http.StatusOK},
		{"foreign service", "foreign", `{"transcript_language":"ur"}`, http.StatusForbidden},
		{"unsupported code", owner, `{"transcript_language":"en-US"}`, http.StatusBadRequest},
		{"null default", owner, `{"transcript_language":null}`, http.StatusBadRequest},
		{"unrelated policy", owner, `{"transcript_language":"ur","transcript_retention_seconds":1}`, http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &rateLimitTenantRepository{values: map[utilities.ID]tenants.Tenant{id: {ID: id, CreatedByServiceID: &owner}}}
			principal := authentication.Principal{Kind: authentication.PrincipalService, ServiceID: test.serviceID, Scopes: []authentication.Scope{authentication.ScopeTenantsWrite}}
			response := serveAccountEndpoint(updateTenantEndpoint(tenants.NewService(repository), authorization.NewTenantPolicy(nil, repository)), principal, http.MethodPatch, "/tenants/"+id.String(), test.body)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d: %s", response.Code, test.status, response.Body.String())
			}
			if test.status != http.StatusOK && repository.writes != 0 {
				t.Fatal("rejected request changed settings")
			}
		})
	}
}
