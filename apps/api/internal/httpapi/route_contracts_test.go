package httpapi_test

import (
	"net/http"
	"strings"
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
		{http.MethodGet, "/v1/tenants/{tenant_id}/api-keys"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/api-keys"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/api-keys/{api_key_id}/rotate"},
		{http.MethodDelete, "/v1/tenants/{tenant_id}/api-keys/{api_key_id}"},
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
		{http.MethodGet, "/v1/tenants/{tenant_id}/recordings/{recording_id}/pipeline"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/recordings/{recording_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/recordings/{recording_id}/download-url"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/recordings/{recording_id}/transcripts"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms/{room_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/rooms/{room_id}"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/webhook-endpoints"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/webhook-endpoints"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}"},
		{http.MethodDelete, "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/rotate-secret"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/test"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}/redeliver"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/deadline"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/end"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/host/recover"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/remove"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/access"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/tracks"},
		{http.MethodPut, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/tracks/close"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/renegotiate"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/publications"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/sync-token"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/recordings"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/recording-reservations"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}"},
		{http.MethodPatch, "/v1/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}"},
		{http.MethodDelete, "/v1/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/transcripts"},
		{http.MethodGet, "/v1/tenants/{tenant_id}/transcripts/{transcript_id}"},
		{http.MethodDelete, "/v1/tenants/{tenant_id}/transcripts/{transcript_id}"},
		{http.MethodPost, "/v1/tenants/{tenant_id}/transcripts/{transcript_id}/download-url"},
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
		if !publicContract(contract.Method, contract.Path) && contract.Auth != httpapi.APIAuthSessionOrBearer && contract.Auth != httpapi.APIAuthParticipantMedia {
			t.Fatalf("%s %s should advertise a supported auth family", contract.Method, contract.Path)
		}
		if strings.Contains(contract.Path, "/media/sfu/") && contract.Auth != httpapi.APIAuthParticipantMedia {
			t.Fatalf("%s %s should advertise participant media auth", contract.Method, contract.Path)
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

func TestWebhookRouteContracts(t *testing.T) {
	contracts := make(map[string]httpapi.APIRouteContract)
	for _, contract := range httpapi.PreviewRouteContracts() {
		contracts[contract.OperationID] = contract
	}

	tests := []struct {
		operationID string
		status      int
		request     string
		response    string
		parameters  []string
	}{
		{"createWebhookEndpoint", http.StatusCreated, "CreateWebhookEndpointRequest", "WebhookEndpointWithSecret", []string{"path:tenant_id", "header:Idempotency-Key"}},
		{"listWebhookEndpoints", http.StatusOK, "", "WebhookEndpointList", []string{"path:tenant_id", "query:page_size", "query:cursor"}},
		{"getWebhookEndpoint", http.StatusOK, "", "WebhookEndpoint", []string{"path:tenant_id", "path:endpoint_id"}},
		{"updateWebhookEndpoint", http.StatusOK, "UpdateWebhookEndpointRequest", "WebhookEndpoint", []string{"path:tenant_id", "path:endpoint_id", "header:If-Match", "header:Idempotency-Key"}},
		{"deleteWebhookEndpoint", http.StatusNoContent, "", "", []string{"path:tenant_id", "path:endpoint_id", "header:If-Match", "header:Idempotency-Key"}},
		{"rotateWebhookEndpointSecret", http.StatusOK, "RotateWebhookSecretRequest", "RotateWebhookSecretResponse", []string{"path:tenant_id", "path:endpoint_id", "header:Idempotency-Key"}},
		{"testWebhookEndpoint", http.StatusCreated, "", "WebhookDeliveryCreated", []string{"path:tenant_id", "path:endpoint_id", "header:Idempotency-Key"}},
		{"listWebhookDeliveries", http.StatusOK, "", "WebhookDeliveryList", []string{"path:tenant_id", "path:endpoint_id", "query:state", "query:event_type", "query:page_size", "query:cursor"}},
		{"getWebhookDelivery", http.StatusOK, "", "WebhookDeliveryDetail", []string{"path:tenant_id", "path:endpoint_id", "path:delivery_id"}},
		{"redeliverWebhookDelivery", http.StatusCreated, "", "WebhookDeliveryCreated", []string{"path:tenant_id", "path:endpoint_id", "path:delivery_id", "header:Idempotency-Key"}},
	}
	for _, test := range tests {
		t.Run(test.operationID, func(t *testing.T) {
			contract, ok := contracts[test.operationID]
			if !ok {
				t.Fatal("missing route contract")
			}
			if contract.Auth != httpapi.APIAuthSessionOrBearer {
				t.Fatalf("auth = %q", contract.Auth)
			}
			readOperation := test.operationID == "listWebhookEndpoints" || test.operationID == "getWebhookEndpoint" || test.operationID == "listWebhookDeliveries" || test.operationID == "getWebhookDelivery"
			wantPolicy := ratelimit.PolicyNameAuthenticatedWrite
			wantLimit := 60
			if readOperation {
				wantPolicy = ratelimit.PolicyNameWebhookRead
				wantLimit = 300
			}
			if contract.RateLimit.Name != wantPolicy || contract.RateLimit.Limit != wantLimit || contract.RateLimit.Window != time.Minute {
				t.Fatalf("rate limit = %#v, want %s/%d per minute", contract.RateLimit, wantPolicy, wantLimit)
			}
			if !contractHasErrorCode(contract, "rate_limited") {
				t.Fatal("route does not declare rate_limited")
			}
			if contract.Request == nil && test.request != "" || contract.Request != nil && contract.Request.Name != test.request {
				t.Fatalf("request schema = %#v, want %q", contract.Request, test.request)
			}
			response := responseForStatus(contract, test.status)
			if response == nil {
				t.Fatalf("missing %d response", test.status)
			}
			if response.Schema == nil && test.response != "" || response.Schema != nil && response.Schema.Name != test.response {
				t.Fatalf("response schema = %#v, want %q", response.Schema, test.response)
			}
			if got := parameterNames(contract.Parameters); !equalStrings(got, test.parameters) {
				t.Fatalf("parameters = %#v, want %#v", got, test.parameters)
			}
		})
	}

	list := contracts["listWebhookDeliveries"]
	state := parameterByName(list.Parameters, "state")
	if state == nil || state.Type != "array" || state.ItemsType != "string" || !equalStrings(state.Enum, []string{"pending", "retry_wait", "delivering", "succeeded", "exhausted", "canceled", "erased"}) {
		t.Fatalf("state parameter = %#v", state)
	}
	eventType := parameterByName(list.Parameters, "event_type")
	if eventType == nil || eventType.Type != "array" || eventType.ItemsType != "string" || len(eventType.Enum) != 15 {
		t.Fatalf("event_type parameter = %#v", eventType)
	}
}

func responseForStatus(contract httpapi.APIRouteContract, status int) *httpapi.APIResponseContract {
	for index := range contract.Responses {
		if contract.Responses[index].Status == status {
			return &contract.Responses[index]
		}
	}
	return nil
}

func parameterNames(parameters []httpapi.APIParameterContract) []string {
	result := make([]string, 0, len(parameters))
	for _, parameter := range parameters {
		result = append(result, parameter.In+":"+parameter.Name)
	}
	return result
}

func parameterByName(parameters []httpapi.APIParameterContract, name string) *httpapi.APIParameterContract {
	for index := range parameters {
		if parameters[index].Name == name {
			return &parameters[index]
		}
	}
	return nil
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
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

func TestSessionLifecycleRouteContracts(t *testing.T) {
	contracts := make(map[string]httpapi.APIRouteContract)
	for _, contract := range httpapi.PreviewRouteContracts() {
		contracts[contract.OperationID] = contract
	}
	tests := []struct {
		operationID string
		status      int
		body        string
		parameters  []string
	}{
		{"createRoomSession", http.StatusCreated, "CreateRoomSessionRequest", []string{"path:tenant_id", "path:room_id", "header:Idempotency-Key"}},
		{"admitSessionParticipant", http.StatusCreated, "AdmitSessionParticipantRequest", []string{"path:tenant_id", "path:room_id", "path:session_id", "header:Idempotency-Key"}},
		{"issueSessionParticipantSyncToken", http.StatusCreated, "", []string{"path:tenant_id", "path:room_id", "path:session_id", "path:participant_session_id"}},
		{"removeSessionParticipant", http.StatusAccepted, "RemoveSessionParticipantRequest", []string{"path:tenant_id", "path:room_id", "path:session_id", "path:participant_session_id", "header:Idempotency-Key"}},
		{"endRoomSession", http.StatusAccepted, "", []string{"path:tenant_id", "path:room_id", "path:session_id", "header:Idempotency-Key"}},
	}
	for _, test := range tests {
		contract, ok := contracts[test.operationID]
		if !ok {
			t.Fatalf("missing %s contract", test.operationID)
		}
		if contract.Responses[0].Status != test.status || contract.RateLimit.Name != ratelimit.PolicyNameAuthenticatedWrite {
			t.Fatalf("%s status/rate limit = %d/%q", test.operationID, contract.Responses[0].Status, contract.RateLimit.Name)
		}
		if test.body == "" {
			if contract.Request != nil {
				t.Fatalf("%s unexpectedly has request body", test.operationID)
			}
		} else if contract.Request == nil || contract.Request.Name != test.body {
			t.Fatalf("%s request body = %#v, want %s", test.operationID, contract.Request, test.body)
		}
		if got := contractParameterNames(contract); !sameStrings(got, test.parameters) {
			t.Fatalf("%s parameters = %v, want %v", test.operationID, got, test.parameters)
		}
	}
	createContract := contracts["createRoomSession"]
	for _, parameter := range createContract.Parameters {
		if parameter.Name == "Idempotency-Key" {
			if parameter.Pattern != `^[A-Za-z0-9_-]+$` || parameter.MinLength != 16 || parameter.MaxLength != 128 {
				t.Fatalf("create idempotency key contract = %#v", parameter)
			}
			return
		}
	}
	t.Fatal("createRoomSession does not declare Idempotency-Key")
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
