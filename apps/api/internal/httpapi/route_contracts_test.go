package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

func TestJourneyEventIntakeRateLimitContract(t *testing.T) {
	for _, contract := range httpapi.PreviewRouteContracts() {
		if contract.OperationID != "intakeJourneyEvents" {
			continue
		}

		want := ratelimit.Policy{
			Name:   ratelimit.PolicyNameTelemetryIntake,
			Limit:  600,
			Window: time.Minute,
		}
		if contract.RateLimit != want {
			t.Fatalf("rate limit = %#v, want %#v", contract.RateLimit, want)
		}
		return
	}

	t.Fatal("missing intakeJourneyEvents contract")
}

func TestPreviewRouteContracts(t *testing.T) {
	contracts := httpapi.PreviewRouteContracts()
	expected := []expectedRoute{
		{http.MethodGet, "/v1/auth/google/callback"},
		{http.MethodGet, "/v1/auth/google/start"},
		{http.MethodPost, "/v1/auth/login"},
		{http.MethodPost, "/v1/auth/logout"},
		{http.MethodPost, "/v1/auth/register"},
		{http.MethodGet, "/v1/me"},
		{http.MethodPost, "/v1/telemetry/journey-events"},
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
		{http.MethodGet, "/v1/tenants/{tenant_id}/integrations/services"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/integrations/connections"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/integrations/connections"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/refresh"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/actions"},
		{http.MethodDelete, "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/recordings"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/recordings/{recording_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/recordings/{recording_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/recordings/{recording_id}/download-url"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/recordings/{recording_id}/transcripts"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/recordings/{recording_id}/transcriptions"},
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

func TestIntegrationRouteContracts(t *testing.T) {
	contracts := make(map[string]httpapi.APIRouteContract)
	for _, contract := range httpapi.PreviewRouteContracts() {
		contracts[contract.OperationID] = contract
	}

	tests := []struct {
		operationID string
		method      string
		path        string
		status      int
		body        string
		rateLimited bool
		parameters  []string
		errors      []string
	}{
		{
			operationID: "listIntegrationServices",
			method:      http.MethodGet,
			path:        "/v1/tenants/{tenant_id}/integrations/services",
			status:      http.StatusOK,
			parameters:  []string{"path:tenant_id"},
		},
		{
			operationID: "startIntegrationConnection",
			method:      http.MethodPost,
			path:        "/v1/tenants/{tenant_id}/integrations/connections",
			status:      http.StatusCreated,
			body:        "StartIntegrationConnectionRequest",
			rateLimited: true,
			parameters:  []string{"path:tenant_id"},
			errors:      []string{"invalid_request", "payload_too_large", "invalid_callback_url", "rate_limited"},
		},
		{
			operationID: "listIntegrationConnections",
			method:      http.MethodGet,
			path:        "/v1/tenants/{tenant_id}/integrations/connections",
			status:      http.StatusOK,
			parameters:  []string{"path:tenant_id", "query:provider", "query:service", "query:status", "query:page_size", "query:cursor"},
			errors:      []string{"invalid_page_size", "invalid_cursor"},
		},
		{
			operationID: "getIntegrationConnection",
			method:      http.MethodGet,
			path:        "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}",
			status:      http.StatusOK,
			parameters:  []string{"path:tenant_id", "path:connection_id"},
			errors:      []string{"invalid_integration_connection_id"},
		},
		{
			operationID: "refreshIntegrationConnection",
			method:      http.MethodPost,
			path:        "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/refresh",
			status:      http.StatusOK,
			rateLimited: true,
			parameters:  []string{"path:tenant_id", "path:connection_id"},
			errors:      []string{"invalid_integration_connection_id", "rate_limited"},
		},
		{
			operationID: "executeIntegrationAction",
			method:      http.MethodPost,
			path:        "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/actions",
			status:      http.StatusOK,
			body:        "ExecuteIntegrationActionRequest",
			rateLimited: true,
			parameters:  []string{"path:tenant_id", "path:connection_id"},
			errors:      []string{"invalid_request", "payload_too_large", "invalid_integration_action", "invalid_integration_action_input", "invalid_integration_action_text", "rate_limited"},
		},
		{
			operationID: "disableIntegrationConnection",
			method:      http.MethodDelete,
			path:        "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}",
			status:      http.StatusOK,
			rateLimited: true,
			parameters:  []string{"path:tenant_id", "path:connection_id", "query:revoke"},
			errors:      []string{"invalid_integration_connection_id", "rate_limited"},
		},
	}

	for _, test := range tests {
		contract, ok := contracts[test.operationID]
		if !ok {
			t.Fatalf("missing %s contract", test.operationID)
		}
		if contract.Method != test.method || contract.Path != test.path {
			t.Fatalf("%s route = %s %s, want %s %s", test.operationID, contract.Method, contract.Path, test.method, test.path)
		}
		if contract.Auth != httpapi.APIAuthSessionOrBearer {
			t.Fatalf("%s auth = %q, want session or bearer", test.operationID, contract.Auth)
		}
		if contract.Responses[0].Status != test.status {
			t.Fatalf("%s success status = %d, want %d", test.operationID, contract.Responses[0].Status, test.status)
		}
		if test.rateLimited {
			if contract.RateLimit.Name != ratelimit.PolicyNameAuthenticatedWrite {
				t.Fatalf("%s rate limit = %q, want %q", test.operationID, contract.RateLimit.Name, ratelimit.PolicyNameAuthenticatedWrite)
			}
		} else if contract.RateLimit.Name != "" {
			t.Fatalf("%s unexpectedly declares rate limit %q", test.operationID, contract.RateLimit.Name)
		}
		if test.body == "" {
			if contract.Request != nil || contract.BodyLimitBytes != 0 {
				t.Fatalf("%s unexpectedly declares a request body: %#v", test.operationID, contract)
			}
		} else if contract.Request == nil || contract.Request.Name != test.body || contract.BodyLimitBytes != 1<<20 {
			t.Fatalf("%s request body = %#v, want %s limited to %d bytes", test.operationID, contract.Request, test.body, 1<<20)
		}
		if got := contractParameterNames(contract); !sameStrings(got, test.parameters) {
			t.Fatalf("%s parameters = %v, want %v", test.operationID, got, test.parameters)
		}
		for _, code := range append([]string{"unauthenticated", "forbidden", "service_unavailable", "invalid_tenant_id", "internal_error"}, test.errors...) {
			if !contractHasErrorCode(contract, code) {
				t.Fatalf("%s does not declare %q", test.operationID, code)
			}
		}
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

func contractParameterNames(contract httpapi.APIRouteContract) []string {
	parameters := make([]string, 0, len(contract.Parameters))
	for _, parameter := range contract.Parameters {
		parameters = append(parameters, parameter.In+":"+parameter.Name)
	}
	return parameters
}

func sameStrings(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

func contractHasErrorCode(contract httpapi.APIRouteContract, code string) bool {
	for _, apiError := range contract.Errors {
		if apiError.Code == code {
			return true
		}
	}
	return false
}
