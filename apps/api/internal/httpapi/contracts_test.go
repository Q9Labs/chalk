package httpapi

import (
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/apitest"
)

// Bodyless writes still have an explicit request contract: the path parameters.
var bodylessWriteReasons = map[string]string{
	"finalizeChatAttachmentUpload":       "Upload ID is in the path.",
	"archiveSpace":                       "Space ID is in the path.",
	"prepareSpaceEntrance":               "Space ID is in the path.",
	"endEpisode":                         "Episode ID is in the path.",
	"cancelEpisodeParticipantJoin":       "Participant ID is in the path.",
	"issueEpisodeParticipantSyncToken":   "Participant ID is in the path.",
	"approveSpacePublicAdmissionRequest": "Request handle is in the path.",
	"denySpacePublicAdmissionRequest":    "Request handle is in the path.",
	"rotateSpacePublicInvite":            "Space ID is in the path.",
	"restoreSpace":                       "Space ID is in the path.",
	"redeliverWebhookDelivery":           "Delivery ID is in the path.",
	"testWebhookEndpoint":                "Endpoint ID is in the path.",
}

func mountedRoutes(t *testing.T, options Options) map[string]bool {
	t.Helper()
	router, ok := NewRouter(options).(chi.Routes)
	if !ok {
		t.Fatal("real router does not expose mounted routes")
	}
	routes := make(map[string]bool)
	if err := chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		routes[method+" "+path] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return routes
}

func TestMountedRouteContractCompleteness(t *testing.T) {
	matrix, err := apitest.RouteMatrix()
	if err != nil {
		t.Fatal(err)
	}
	contracts := make(map[string]APIRouteContract)
	operations := make(map[string]bool)
	pathParameter := regexp.MustCompile(`\{([^}]+)\}`)
	for _, contract := range PreviewRouteContracts() {
		key := contract.Method + " " + contract.Path
		if _, exists := contracts[key]; exists {
			t.Errorf("duplicate contract: %s", key)
		}
		contracts[key] = contract
		if contract.OperationID == "" || operations[contract.OperationID] {
			t.Errorf("%s: missing or duplicate operation ID %q", key, contract.OperationID)
		}
		operations[contract.OperationID] = true
		if contract.MountPath == "" || contract.Path != "/v1"+contract.MountPath {
			t.Errorf("%s: contract mount path does not match public path", key)
		}
		public := matrix[key].PublicReason != ""
		if public != (contract.Auth == "") {
			t.Errorf("%s: auth requirement disagrees with explicit public allowlist", key)
		}
		switch contract.Auth {
		case "", APIAuthSessionOrBearer, APIAuthParticipantMedia, APIAuthParticipantSync:
		default:
			t.Errorf("%s: unknown auth requirement %q", key, contract.Auth)
		}
		if len(contract.Errors) == 0 {
			t.Errorf("%s: missing error responses", key)
		}
		statuses := make(map[int]bool)
		for _, failure := range contract.Errors {
			if failure.Status < 400 || failure.Status > 599 || failure.Code == "" || failure.Message == "" {
				t.Errorf("%s: incomplete error response: %+v", key, failure)
			}
			statuses[failure.Status] = true
		}
		if !public && (!statuses[401] || !statuses[403]) {
			t.Errorf("%s: protected route must declare 401 and 403", key)
		}
		if len(contract.Responses) == 0 {
			t.Errorf("%s: missing response metadata", key)
		}
		for _, response := range contract.Responses {
			if response.Status < 200 || response.Status >= 400 {
				t.Errorf("%s: invalid success status %d", key, response.Status)
			}
			if response.Schema == nil && response.Status != http.StatusNoContent && len(response.Headers) == 0 {
				t.Errorf("%s: missing response schema or bodyless response headers", key)
			}
			if response.Schema != nil && (response.Schema.Name == "" || response.Schema.Type == nil) {
				t.Errorf("%s: incomplete typed response schema", key)
			}
		}
		parameters := make(map[string]bool)
		for _, parameter := range contract.Parameters {
			if parameter.Name == "" || parameter.Type == "" || (parameter.In != "path" && parameter.In != "query") {
				t.Errorf("%s: incomplete parameter metadata: %+v", key, parameter)
			}
			if parameter.In == "path" {
				parameters[parameter.Name] = parameter.Required
			}
		}
		for _, match := range pathParameter.FindAllStringSubmatch(contract.Path, -1) {
			if !parameters[match[1]] {
				t.Errorf("%s: missing required path parameter %s", key, match[1])
			}
		}
		if contract.Request != nil {
			if contract.Request.Name == "" || contract.Request.Type == nil || contract.BodyLimitBytes <= 0 {
				t.Errorf("%s: incomplete typed request metadata", key)
			}
		} else if contract.Method == http.MethodPost || contract.Method == http.MethodPut || contract.Method == http.MethodPatch {
			if bodylessWriteReasons[contract.OperationID] == "" {
				t.Errorf("%s: missing request body metadata or explicit bodyless-write reason", key)
			}
		}
	}

	// Exercise both runtime composition branches. A non-nil service enables the
	// artifact branch without reading data during route inventory.
	for _, variant := range []struct {
		name    string
		options Options
	}{
		{name: "fallback"},
		{name: "artifacts", options: Options{TranscriptArtifacts: struct{ TranscriptArtifactService }{}}},
	} {
		t.Run(variant.name, func(t *testing.T) {
			mounted := mountedRoutes(t, variant.options)
			for route := range mounted {
				if matrix[route].ProtocolReason != "" {
					continue
				}
				if _, declared := contracts[route]; !declared {
					t.Errorf("mounted route has no typed endpoint declaration in PreviewRouteContracts: %s", route)
				}
			}
			for route := range contracts {
				if !mounted[route] {
					t.Errorf("declared route is not mounted: %s", route)
				}
			}
			for route, row := range matrix {
				if strings.HasPrefix(route, "POST /internal/") {
					continue
				}
				if !mounted[route] || (len(row.Credentials) == 0 && strings.TrimSpace(row.PublicReason) == "") {
					t.Errorf("stale or unexplained public allowlist entry: %s", route)
				}
			}
		})
	}
}
