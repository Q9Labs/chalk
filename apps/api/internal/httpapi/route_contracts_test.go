package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

func TestPreviewRouteContracts(t *testing.T) {
	contracts := httpapi.PreviewRouteContracts()
	expected := []expectedRoute{
		{http.MethodGet, "/v1/auth/google/callback"},
		{http.MethodGet, "/v1/auth/google/start"},
		{http.MethodPost, "/v1/auth/login"},
		{http.MethodPost, "/v1/auth/logout"},
		{http.MethodPost, "/v1/auth/register"},
		{http.MethodGet, "/v1/me"},
		{http.MethodGet, "/v1/regions"},
		{http.MethodGet, "/v1/tenants"},
		{http.MethodPost, "/v1/tenants"},
		{http.MethodGet, "/v1/tenants/{tenant_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/audit-logs"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/audit-logs/{audit_log_id}"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/memberships"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/memberships"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/memberships/{membership_id}"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/recordings"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/recordings/{recording_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/recordings/{recording_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/recordings/{recording_id}/download-url"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/recordings/{recording_id}/transcripts"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms/{room_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/rooms/{room_id}"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/recordings"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/transcripts"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/transcripts/{transcript_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/transcripts/{transcript_id}"},
		{http.MethodGet, "/v1/users"},
		{http.MethodPost, "/v1/users"},
		{http.MethodGet, "/v1/users/{user_id}"},
	}

	seenOperations := make(map[string]string)
	seenRoutes := make(map[string]map[string]struct{})
	for _, contract := range contracts {
		if contract.OperationID == "" {
			t.Fatalf("%s %s has empty operation id", contract.Method, contract.Path)
		}
		if existing, ok := seenOperations[contract.OperationID]; ok {
			t.Fatalf("operation id %q is used by both %s and %s %s", contract.OperationID, existing, contract.Method, contract.Path)
		}
		seenOperations[contract.OperationID] = contract.Method + " " + contract.Path

		if contract.Path == "" || contract.Method == "" || contract.MountPath == "" {
			t.Fatalf("contract %q has incomplete routing metadata: %#v", contract.OperationID, contract)
		}
		if len(contract.Responses) == 0 {
			t.Fatalf("%s %s has no success response metadata", contract.Method, contract.Path)
		}
		if len(contract.Errors) == 0 {
			t.Fatalf("%s %s has no error metadata", contract.Method, contract.Path)
		}
		if !publicContract(contract.Method, contract.Path) && contract.Auth != httpapi.APIAuthSessionOrBearer {
			t.Fatalf("%s %s should advertise session or bearer auth", contract.Method, contract.Path)
		}

		if seenRoutes[contract.Path] == nil {
			seenRoutes[contract.Path] = make(map[string]struct{})
		}
		seenRoutes[contract.Path][contract.Method] = struct{}{}
	}

	for _, route := range expected {
		if _, ok := seenRoutes[route.path][route.method]; !ok {
			t.Fatalf("missing route contract for %s %s", route.method, route.path)
		}
	}
	if len(seenOperations) != len(expected) {
		t.Fatalf("expected %d route contracts, got %d", len(expected), len(seenOperations))
	}
}

type expectedRoute struct {
	method string
	path   string
}

func publicContract(method string, path string) bool {
	public := map[string]struct{}{
		http.MethodGet + " /v1/auth/google/callback": {},
		http.MethodGet + " /v1/auth/google/start":    {},
		http.MethodPost + " /v1/auth/login":          {},
		http.MethodPost + " /v1/auth/register":       {},
	}
	_, ok := public[method+" "+path]
	return ok
}
