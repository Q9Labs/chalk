package composio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCreateConnectLinkResolvesManagedAuthConfig(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		if r.Header.Get("x-api-key") != "test-key" {
			t.Fatalf("x-api-key header missing")
		}

		switch r.URL.Path {
		case "/api/v3.1/auth_configs":
			if r.URL.Query().Get("toolkit_slug") != "slack" {
				t.Fatalf("toolkit query = %q, want slack", r.URL.Query().Get("toolkit_slug"))
			}
			writeJSON(t, w, http.StatusOK, map[string]any{
				"items": []map[string]any{
					{
						"id":                  "ac_slack",
						"status":              "ENABLED",
						"is_composio_managed": true,
						"toolkit":             map[string]string{"slug": "slack"},
					},
				},
			})
		case "/api/v3.1/connected_accounts/link":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if body["auth_config_id"] != "ac_slack" || body["user_id"] != "22222222-2222-4222-8222-222222222222" {
				t.Fatalf("request body = %#v", body)
			}
			if body["allow_multiple"] != true {
				t.Fatalf("allow_multiple = %#v, want true", body["allow_multiple"])
			}
			writeJSON(t, w, http.StatusOK, map[string]any{
				"redirect_url":         "https://composio.test/connect",
				"connected_account_id": "ca_slack",
				"expires_at":           "2026-07-06T12:00:00Z",
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	adapter := adapterForServer(t, server)
	link, err := adapter.CreateConnectLink(context.Background(), integrations.CreateConnectLinkInput{
		UserID:      mustID(t, "22222222-2222-4222-8222-222222222222"),
		Service:     "slack",
		ToolkitSlug: "slack",
	})
	if err != nil {
		t.Fatalf("create connect link: %v", err)
	}
	if link.URL != "https://composio.test/connect" || link.ExternalAccountRef != "ca_slack" {
		t.Fatalf("link = %#v", link)
	}
	if link.ExternalAuthConfigRef == nil || *link.ExternalAuthConfigRef != "ac_slack" {
		t.Fatalf("auth config ref = %v, want ac_slack", link.ExternalAuthConfigRef)
	}
	if len(paths) != 2 {
		t.Fatalf("paths = %#v, want auth config lookup plus link", paths)
	}
}

func TestGetConnectionMapsStatusAndScopes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/connected_accounts/ca_slack" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		writeJSON(t, w, http.StatusOK, map[string]any{
			"id":               "ca_slack",
			"alias":            "Product",
			"status":           "ACTIVE",
			"created_at":       "2026-07-06T10:00:00Z",
			"requested_scopes": []string{"chat:write"},
			"toolkit":          map[string]string{"slug": "slack"},
			"auth_config":      map[string]any{"id": "ac_slack", "is_composio_managed": true},
		})
	}))
	defer server.Close()

	connection, err := adapterForServer(t, server).GetConnection(context.Background(), integrations.GetProviderConnectionInput{
		ExternalAccountRef: "ca_slack",
	})
	if err != nil {
		t.Fatalf("get connection: %v", err)
	}
	if connection.Status != integrations.StatusActive {
		t.Fatalf("status = %q, want active", connection.Status)
	}
	if connection.AccountLabel == nil || *connection.AccountLabel != "Product" {
		t.Fatalf("label = %v, want Product", connection.AccountLabel)
	}
	if len(connection.Scopes) != 1 || connection.Scopes[0] != "chat:write" {
		t.Fatalf("scopes = %#v", connection.Scopes)
	}
}

func TestGetConnectionMapsNotFoundToConnectionNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/connected_accounts/ca_missing" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		writeJSON(t, w, http.StatusNotFound, map[string]any{"error": "missing"})
	}))
	defer server.Close()

	_, err := adapterForServer(t, server).GetConnection(context.Background(), integrations.GetProviderConnectionInput{
		ExternalAccountRef: "ca_missing",
	})
	if !errors.Is(err, integrations.ErrConnectionNotFound) {
		t.Fatalf("error = %v, want connection not found", err)
	}
}

func TestRefreshConnectionReturnsRedirectURL(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/api/v3.1/connected_accounts/ca_slack/refresh":
			writeJSON(t, w, http.StatusOK, map[string]any{
				"redirect_url": "https://composio.test/reauth",
			})
		case "/api/v3.1/connected_accounts/ca_slack":
			writeJSON(t, w, http.StatusOK, map[string]any{
				"id":               "ca_slack",
				"status":           "EXPIRED",
				"requested_scopes": []string{"chat:write"},
				"toolkit":          map[string]string{"slug": "slack"},
				"auth_config":      map[string]any{"id": "ac_slack", "is_composio_managed": true},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	connection, err := adapterForServer(t, server).RefreshConnection(context.Background(), integrations.RefreshConnectionInput{
		ExternalAccountRef: "ca_slack",
	})
	if err != nil {
		t.Fatalf("refresh connection: %v", err)
	}
	if connection.RefreshURL != "https://composio.test/reauth" {
		t.Fatalf("refresh url = %q, want provider redirect", connection.RefreshURL)
	}
	if connection.Status != integrations.StatusExpired {
		t.Fatalf("status = %s, want expired", connection.Status)
	}
	if len(paths) != 2 || paths[0] != "POST /api/v3.1/connected_accounts/ca_slack/refresh" || paths[1] != "GET /api/v3.1/connected_accounts/ca_slack" {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestExecuteActionPostsConnectedAccountAndArguments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/tools/execute/SLACK_SEND_MESSAGE" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		var body executeToolRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body.ConnectedAccountID != "ca_slack" || body.UserID != "22222222-2222-4222-8222-222222222222" {
			t.Fatalf("body target = %#v", body)
		}
		if body.Version != "20260701_00" {
			t.Fatalf("version = %q, want concrete version", body.Version)
		}
		if body.Arguments == nil || (*body.Arguments)["channel"] != "C123" {
			t.Fatalf("arguments = %#v", body.Arguments)
		}
		writeJSON(t, w, http.StatusOK, map[string]any{
			"successful": true,
			"log_id":     "log_123",
			"data":       map[string]any{"ok": true},
		})
	}))
	defer server.Close()

	result, err := adapterForServer(t, server).ExecuteAction(context.Background(), integrations.ExecuteProviderActionInput{
		UserID:             mustID(t, "22222222-2222-4222-8222-222222222222"),
		ExternalAccountRef: "ca_slack",
		ActionSlug:         "SLACK_SEND_MESSAGE",
		Version:            "20260701_00",
		Arguments:          map[string]any{"channel": "C123"},
	})
	if err != nil {
		t.Fatalf("execute action: %v", err)
	}
	if result.LogID != "log_123" || result.Data["ok"] != true {
		t.Fatalf("result = %#v", result)
	}
}

func TestExecuteActionOmitsLatestPseudoVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if _, ok := body["version"]; ok {
			t.Fatalf("version field present for latest pseudo-version: %s", body["version"])
		}
		writeJSON(t, w, http.StatusOK, map[string]any{
			"successful": true,
			"data":       map[string]any{"ok": true},
		})
	}))
	defer server.Close()

	_, err := adapterForServer(t, server).ExecuteAction(context.Background(), integrations.ExecuteProviderActionInput{
		UserID:             mustID(t, "22222222-2222-4222-8222-222222222222"),
		ExternalAccountRef: "ca_slack",
		ActionSlug:         "SLACK_SEND_MESSAGE",
		Version:            "latest",
	})
	if err != nil {
		t.Fatalf("execute action: %v", err)
	}
}

func TestExecuteActionOmitsArgumentsForTextRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if _, ok := body["arguments"]; ok {
			t.Fatalf("arguments field present for text request: %s", body["arguments"])
		}
		if string(body["text"]) != `"write a recap"` {
			t.Fatalf("text = %s", body["text"])
		}
		writeJSON(t, w, http.StatusOK, map[string]any{
			"successful": true,
			"data":       map[string]any{"ok": true},
		})
	}))
	defer server.Close()

	text := "write a recap"
	_, err := adapterForServer(t, server).ExecuteAction(context.Background(), integrations.ExecuteProviderActionInput{
		UserID:             mustID(t, "22222222-2222-4222-8222-222222222222"),
		ExternalAccountRef: "ca_slack",
		ActionSlug:         "SLACK_SEND_MESSAGE",
		Text:               &text,
	})
	if err != nil {
		t.Fatalf("execute action: %v", err)
	}
}

func TestExecuteActionSendsEmptyArgumentsForStructuredRequestWithoutArgs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		rawArguments, ok := body["arguments"]
		if !ok {
			t.Fatal("missing arguments field")
		}
		var arguments map[string]any
		if err := json.Unmarshal(rawArguments, &arguments); err != nil {
			t.Fatalf("decode arguments: %v", err)
		}
		if len(arguments) != 0 {
			t.Fatalf("arguments = %#v, want empty object", arguments)
		}
		if _, ok := body["text"]; ok {
			t.Fatalf("text field present: %s", body["text"])
		}
		writeJSON(t, w, http.StatusOK, map[string]any{
			"successful": true,
			"data":       map[string]any{"ok": true},
		})
	}))
	defer server.Close()

	_, err := adapterForServer(t, server).ExecuteAction(context.Background(), integrations.ExecuteProviderActionInput{
		UserID:             mustID(t, "22222222-2222-4222-8222-222222222222"),
		ExternalAccountRef: "ca_slack",
		ActionSlug:         "SLACK_SEND_MESSAGE",
	})
	if err != nil {
		t.Fatalf("execute action: %v", err)
	}
}

func TestExecuteActionDoesNotMapToolNotFoundToConnectionNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/tools/execute/SLACK_SEND_MESSAGE" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		writeJSON(t, w, http.StatusNotFound, map[string]any{"error": "missing tool"})
	}))
	defer server.Close()

	_, err := adapterForServer(t, server).ExecuteAction(context.Background(), integrations.ExecuteProviderActionInput{
		UserID:             mustID(t, "22222222-2222-4222-8222-222222222222"),
		ExternalAccountRef: "ca_slack",
		ActionSlug:         "SLACK_SEND_MESSAGE",
	})
	if !errors.Is(err, integrations.ErrProviderUnavailable) {
		t.Fatalf("error = %v, want provider unavailable", err)
	}
	if errors.Is(err, integrations.ErrConnectionNotFound) {
		t.Fatalf("error = %v, did not want connection not found", err)
	}
}

func TestListToolsPinsToolkitAndToolSlugFilters(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/tools" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.URL.Query().Get("toolkit_slug") != "slack" {
			t.Fatalf("toolkit slug = %q", r.URL.Query().Get("toolkit_slug"))
		}
		if r.URL.Query().Get("tool_slugs") != "SLACK_SEND_MESSAGE" {
			t.Fatalf("tool slugs = %q", r.URL.Query().Get("tool_slugs"))
		}
		writeJSON(t, w, http.StatusOK, map[string]any{
			"items": []map[string]any{
				{
					"slug":       "SLACK_SEND_MESSAGE",
					"name":       "Send message",
					"version":    "20260701_00",
					"deprecated": false,
					"toolkit":    map[string]string{"slug": "slack", "name": "Slack"},
					"scopes":     []string{"chat:write"},
				},
			},
		})
	}))
	defer server.Close()

	tools, err := adapterForServer(t, server).ListTools(context.Background(), "slack", []string{"SLACK_SEND_MESSAGE"})
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	if len(tools) != 1 || tools[0].Slug != "SLACK_SEND_MESSAGE" {
		t.Fatalf("tools = %#v", tools)
	}
	if tools[0].Deprecated {
		t.Fatalf("tool marked deprecated from explicit false")
	}
}

func TestListToolkitsSearchesEachRequestedSlug(t *testing.T) {
	var searches []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/toolkits" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		search := r.URL.Query().Get("search")
		searches = append(searches, search)
		writeJSON(t, w, http.StatusOK, map[string]any{
			"items": []map[string]any{
				{
					"slug":       search,
					"name":       search,
					"meta":       map[string]any{"version": "latest", "tools_count": 1, "triggers_count": 0},
					"no_auth":    false,
					"deprecated": false,
				},
			},
		})
	}))
	defer server.Close()

	toolkits, err := adapterForServer(t, server).ListToolkits(context.Background(), []string{"slack", "github"})
	if err != nil {
		t.Fatalf("list toolkits: %v", err)
	}
	if len(toolkits) != 2 || toolkits[0].Slug != "slack" || toolkits[1].Slug != "github" {
		t.Fatalf("toolkits = %#v", toolkits)
	}
	if toolkits[0].Deprecated || toolkits[1].Deprecated {
		t.Fatalf("toolkits marked deprecated from explicit false: %#v", toolkits)
	}
	if len(searches) != 2 || searches[0] != "slack" || searches[1] != "github" {
		t.Fatalf("searches = %#v", searches)
	}
}

func TestListToolkitsTreatsDeprecatedMetadataObjectAsActive(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, http.StatusOK, map[string]any{
			"items": []map[string]any{
				{
					"slug": "slack",
					"name": "Slack",
					"meta": map[string]any{"version": "latest"},
					"deprecated": map[string]any{
						"toolkitId": "legacy-toolkit-id",
					},
				},
			},
		})
	}))
	defer server.Close()

	toolkits, err := adapterForServer(t, server).ListToolkits(context.Background(), []string{"slack"})
	if err != nil {
		t.Fatalf("list toolkits: %v", err)
	}
	if len(toolkits) != 1 {
		t.Fatalf("toolkits = %#v", toolkits)
	}
	if toolkits[0].Deprecated {
		t.Fatalf("toolkit marked deprecated from metadata object")
	}
}

func TestRequiredScopesPostsToolList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/tools/scopes/required" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		var body requiredScopesRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if len(body.Tools) != 1 || body.Tools[0] != "SLACK_SEND_MESSAGE" {
			t.Fatalf("tools = %#v", body.Tools)
		}
		writeJSON(t, w, http.StatusOK, map[string]any{
			"scopes_required": []string{"chat:write"},
			"per_tool_requirements": []map[string]any{
				{"tool": "SLACK_SEND_MESSAGE", "scope_requirements": map[string]any{"all_of": []string{"chat:write"}}},
			},
		})
	}))
	defer server.Close()

	scopes, err := adapterForServer(t, server).RequiredScopes(context.Background(), []string{"SLACK_SEND_MESSAGE"}, "latest")
	if err != nil {
		t.Fatalf("required scopes: %v", err)
	}
	if len(scopes.Scopes) != 1 || scopes.Scopes[0] != "chat:write" {
		t.Fatalf("scopes = %#v", scopes.Scopes)
	}
}

func TestManagedAuthConfigMapsNotFoundToAuthUnconfigured(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/auth_configs" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		writeJSON(t, w, http.StatusNotFound, map[string]any{"error": "missing config"})
	}))
	defer server.Close()

	_, err := adapterForServer(t, server).CreateConnectLink(context.Background(), integrations.CreateConnectLinkInput{
		UserID:      mustID(t, "22222222-2222-4222-8222-222222222222"),
		Service:     "slack",
		ToolkitSlug: "slack",
	})
	if !errors.Is(err, integrations.ErrConnectionAuthUnconfigured) {
		t.Fatalf("error = %v, want auth unconfigured", err)
	}
}

func TestProviderErrorMapping(t *testing.T) {
	tests := []struct {
		status int
		want   error
	}{
		{status: http.StatusUnauthorized, want: integrations.ErrProviderUnauthorized},
		{status: http.StatusForbidden, want: integrations.ErrProviderUnauthorized},
		{status: http.StatusTooManyRequests, want: integrations.ErrProviderRateLimited},
		{status: http.StatusBadGateway, want: integrations.ErrProviderUnavailable},
	}

	for _, tt := range tests {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(t, w, tt.status, map[string]any{"error": map[string]string{"slug": "provider_error"}})
			}))
			defer server.Close()

			_, err := adapterForServer(t, server).ListToolkits(context.Background(), []string{"slack"})
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func adapterForServer(t *testing.T, server *httptest.Server) Adapter {
	t.Helper()

	baseURL, err := url.Parse(server.URL + "/api/v3.1")
	if err != nil {
		t.Fatalf("parse base url: %v", err)
	}
	return NewAdapterWithClient("test-key", baseURL, server.Client())
}

func writeJSON(t *testing.T, w http.ResponseWriter, status int, body any) {
	t.Helper()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Fatalf("encode json: %v", err)
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
