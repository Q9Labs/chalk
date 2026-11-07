package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type scopeTestOAuth struct{ MCPOAuthService }

func (scopeTestOAuth) Config() mcpauth.Config { return mcpauth.Config{Issuer: "https://api.example"} }

var testRequestKey = strings.Repeat("k", 16)

const scopeTestMetadata = `https://api.example/.well-known/oauth-protected-resource/mcp`

// The OAuth bundles can never call these: no bundle holds their scopes.
var toolsOutsideEveryBundle = []string{"chalk_update_tenant", "chalk_inspect_tenant", "chalk_set_membership", "chalk_issue_api_key", "chalk_revoke_api_key", "chalk_delete_transcript"}

func scopeTestPrincipal(t *testing.T, kind authentication.PrincipalKind, scopes ...authentication.Scope) authentication.Principal {
	t.Helper()
	tenant, _ := utilities.NewID()
	credential, _ := utilities.NewID()
	p := authentication.Principal{Kind: kind, TenantID: tenant, Scopes: scopes}
	if kind == authentication.PrincipalOAuth {
		p.GrantID = credential
	} else {
		p.APIKeyID = credential
	}
	return p
}

func scopeTestCall(t *testing.T, principal *authentication.Principal, body string) *httptest.ResponseRecorder {
	t.Helper()
	mcpHandler := NewMCPHandler(Options{OAuth: scopeTestOAuth{}})
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	if principal != nil {
		request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), *principal))
	}
	response := httptest.NewRecorder()
	mcpHandler.ServeHTTP(response, request)
	return response
}

type listedTool struct {
	Name        string         `json:"name"`
	InputSchema map[string]any `json:"inputSchema"`
}

func scopeTestList(t *testing.T, principal authentication.Principal) []listedTool {
	t.Helper()
	response := scopeTestCall(t, &principal, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	var envelope struct {
		Result struct {
			Tools []listedTool `json:"tools"`
		} `json:"result"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &envelope) != nil {
		t.Fatalf("tools/list: %d %s", response.Code, response.Body.String())
	}
	return envelope.Result.Tools
}

func toolNames(tools []listedTool) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Name)
	}
	return names
}

func TestMCPToolSchemasHaveNoTopLevelComposition(t *testing.T) {
	for _, tool := range scopeTestList(t, scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.AllScopes...)) {
		if tool.InputSchema["type"] != "object" {
			t.Errorf("%s input schema is not an object", tool.Name)
		}
		for _, keyword := range []string{"anyOf", "oneOf", "allOf"} {
			if _, present := tool.InputSchema[keyword]; present {
				t.Errorf("%s input schema has a top-level %s, which Anthropic's API rejects", tool.Name, keyword)
			}
		}
	}
}

func TestMCPToolListFollowsGrantedScopes(t *testing.T) {
	all := toolNames(scopeTestList(t, scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.AllScopes...)))
	manage := toolNames(scopeTestList(t, scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(mcpauth.ScopeManage)...)))
	read := toolNames(scopeTestList(t, scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(mcpauth.ScopeRead)...)))
	t.Logf("tools listed: api key with all scopes=%d, chalk:manage=%d, chalk:read=%d", len(all), len(manage), len(read))

	if len(all) != 25 || len(manage) != len(all)-len(toolsOutsideEveryBundle) || len(read) != 8 {
		t.Fatalf("listed %d, %d and %d tools for all scopes, chalk:manage and chalk:read", len(all), len(manage), len(read))
	}
	for _, name := range toolsOutsideEveryBundle {
		if !slices.Contains(all, name) || slices.Contains(manage, name) || slices.Contains(read, name) {
			t.Errorf("%s must be listed only for API keys", name)
		}
	}
	for _, name := range []string{"chalk_get_connection", "chalk_configure_webhook", "chalk_prepare_recording", "chalk_create_space"} {
		if !slices.Contains(manage, name) {
			t.Errorf("chalk:manage must list %s", name)
		}
	}
	for _, name := range []string{"chalk_get_connection", "chalk_inspect_spaces", "chalk_inspect_recordings", "chalk_prepare_recording"} {
		if !slices.Contains(read, name) {
			t.Errorf("chalk:read must list %s", name)
		}
	}
	for _, name := range []string{"chalk_create_space", "chalk_configure_webhook", "chalk_end_episode"} {
		if slices.Contains(read, name) {
			t.Errorf("chalk:read must not list %s", name)
		}
	}

	spacesRead := toolNames(scopeTestList(t, scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeSpacesRead)))
	if !slices.Equal(slices.Sorted(slices.Values(spacesRead)), []string{"chalk_inspect_spaces", "chalk_prepare_recording"}) {
		t.Errorf("spaces:read lists %v", spacesRead)
	}
	deleteOnly := toolNames(scopeTestList(t, scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeWebhooksDelete)))
	if !slices.Equal(deleteOnly, []string{"chalk_configure_webhook"}) {
		t.Errorf("webhooks:delete lists %v", deleteOnly)
	}
}

func toolCallBody(name, arguments string) string {
	return `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"` + name + `","arguments":` + arguments + `}}`
}

func TestMCPOAuthStepUpIsAnHTTP403(t *testing.T) {
	read := scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(mcpauth.ScopeRead)...)
	for _, call := range []struct{ tool, arguments string }{
		{"chalk_create_space", `{"body":{"name":"A","slug":"a"},"request_key":"` + testRequestKey + `"}`},
		{"chalk_prepare_recording", `{"space_id":"` + strings.Repeat("a", 36) + `","action":"prepare","starts_at":"2026-01-01T00:00:00Z","expected_revision":1}`},
	} {
		response := scopeTestCall(t, &read, toolCallBody(call.tool, call.arguments))
		want := `Bearer error="insufficient_scope", scope="chalk:manage", resource_metadata="` + scopeTestMetadata + `"`
		if response.Code != http.StatusForbidden || response.Header().Get("WWW-Authenticate") != want {
			t.Errorf("%s: %d, WWW-Authenticate=%q", call.tool, response.Code, response.Header().Get("WWW-Authenticate"))
		}
	}
}

func TestMCPRefusalsWithoutAStepUpStayToolErrors(t *testing.T) {
	read := scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(mcpauth.ScopeRead)...)
	spacesRead := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeSpacesRead)
	for name, call := range map[string]struct {
		principal       authentication.Principal
		tool, arguments string
	}{
		"oauth tool outside every bundle":    {read, "chalk_inspect_tenant", `{"view":"api_keys"}`},
		"oauth tenant settings default":      {read, "chalk_inspect_tenant", `{}`},
		"oauth delete scope no bundle holds": {read, "chalk_configure_webhook", `{"action":"delete","endpoint_id":"` + strings.Repeat("a", 36) + `","revision":1,"request_key":"` + testRequestKey + `"}`},
		"api key missing scope":              {spacesRead, "chalk_create_space", `{"body":{"name":"A","slug":"a"},"request_key":"` + testRequestKey + `"}`},
	} {
		response := scopeTestCall(t, &call.principal, toolCallBody(call.tool, call.arguments))
		var envelope struct {
			Result struct {
				IsError bool `json:"isError"`
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"result"`
		}
		if response.Code != http.StatusOK || response.Header().Get("WWW-Authenticate") != "" || json.Unmarshal(response.Body.Bytes(), &envelope) != nil || !envelope.Result.IsError || !strings.Contains(envelope.Result.Content[0].Text, "auth.forbidden") {
			t.Errorf("%s: %d %q %s", name, response.Code, response.Header().Get("WWW-Authenticate"), response.Body.String())
		}
	}
}

func TestMCPActionCallsStillNeedTheirFields(t *testing.T) {
	all := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.AllScopes...)
	response := scopeTestCall(t, &all, toolCallBody("chalk_configure_webhook", `{"action":"update","endpoint_id":"`+strings.Repeat("a", 36)+`"}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Action update also requires: revision, update, request_key") {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
}

func TestMCPChallengeNamesTheSupportedScopes(t *testing.T) {
	response := scopeTestCall(t, nil, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	want := `Bearer resource_metadata="` + scopeTestMetadata + `", scope="chalk:read chalk:manage"`
	if response.Code != http.StatusUnauthorized || response.Header().Get("WWW-Authenticate") != want {
		t.Fatalf("%d %q", response.Code, response.Header().Get("WWW-Authenticate"))
	}
}

func TestMCPInspectViewsNeedTheirFields(t *testing.T) {
	all := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.AllScopes...)
	space, other := strings.Repeat("a", 36), strings.Repeat("b", 36)
	for _, call := range []struct{ tool, arguments, want string }{
		{"chalk_inspect_spaces", `{"view":"settings"}`, "View settings also requires: space_id"},
		{"chalk_inspect_spaces", `{"view":"invite"}`, "View invite also requires: space_id"},
		{"chalk_inspect_episodes", `{}`, "View list also requires: space_id"},
		{"chalk_inspect_episodes", `{"view":"episode","space_id":"` + space + `"}`, "View episode also requires: episode_id"},
		{"chalk_inspect_episodes", `{"view":"live"}`, "View live also requires: space_ids"},
		{"chalk_inspect_episodes", `{"view":"activity"}`, "View activity also requires: space_ids"},
		{"chalk_inspect_episodes", `{"view":"admissions"}`, "View admissions also requires: space_id"},
		{"chalk_inspect_recordings", `{"view":"recording"}`, "View recording also requires: recording_id"},
		{"chalk_inspect_recordings", `{"view":"download_url","recording_id":"` + other + `"}`, "View download_url also requires: expires_in_seconds"},
		{"chalk_inspect_webhooks", `{"view":"endpoint"}`, "View endpoint also requires: endpoint_id"},
		{"chalk_inspect_webhooks", `{"view":"delivery","endpoint_id":"` + space + `"}`, "View delivery also requires: delivery_id"},
		{"chalk_inspect_webhooks", `{"view":"unknown"}`, "does not equal any of: [endpoints endpoint deliveries delivery]"},
	} {
		response := scopeTestCall(t, &all, toolCallBody(call.tool, call.arguments))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), call.want) {
			t.Errorf("%s %s: %d %s", call.tool, call.arguments, response.Code, response.Body.String())
		}
	}
}

func TestMCPInspectToolsAreListedPerScope(t *testing.T) {
	for scope, want := range map[authentication.Scope]string{
		authentication.ScopeSpacesRead:     "chalk_inspect_spaces",
		authentication.ScopeEpisodesRead:   "chalk_inspect_episodes",
		authentication.ScopeRecordingsRead: "chalk_inspect_recordings",
		authentication.ScopeWebhooksRead:   "chalk_inspect_webhooks",
	} {
		listed := toolNames(scopeTestList(t, scopeTestPrincipal(t, authentication.PrincipalAPIKey, scope)))
		if !slices.Contains(listed, want) {
			t.Errorf("%s does not list %s: %v", scope, want, listed)
		}
		response := scopeTestCall(t, ptr(scopeTestPrincipal(t, authentication.PrincipalAPIKey, scope)), toolCallBody("chalk_inspect_transcripts", `{}`))
		if !strings.Contains(response.Body.String(), "auth.forbidden") {
			t.Errorf("%s read transcripts: %s", scope, response.Body.String())
		}
	}
}

func ptr[T any](v T) *T { return &v }

// The schema publishes one space_ids cap for two views, so the live view's lower cap
// is enforced at the MCP boundary and answered with a typed error, not an internal one.
func TestMCPLiveViewRefusesMoreThanThirtySpaces(t *testing.T) {
	all := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.AllScopes...)
	ids := make([]string, 31)
	for i := range ids {
		id, _ := utilities.NewID()
		ids[i] = `"` + id.String() + `"`
	}
	response := scopeTestCall(t, &all, toolCallBody("chalk_inspect_episodes", `{"view":"live","space_ids":[`+strings.Join(ids, ",")+`]}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "invalid_space_ids") {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
}
