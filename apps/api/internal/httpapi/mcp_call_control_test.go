package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// syncTokenSpy counts the sync tokens it mints and remembers who they were for.
type syncTokenSpy struct {
	issued []synctokens.SubjectKey
}

func (s *syncTokenSpy) IssueForParticipant(_ context.Context, key synctokens.SubjectKey) (synctokens.Token, error) {
	s.issued = append(s.issued, key)
	return synctokens.Token{Value: "sync-secret-fixture", ExpiresAt: time.Now().Add(5 * time.Minute)}, nil
}

func callControlCall(t *testing.T, handler http.Handler, principal authentication.Principal, arguments string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(toolCallBody("chalk_control_call", arguments)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request.WithContext(authentication.ContextWithPrincipal(request.Context(), principal)))
	return response
}

func callArguments(t *testing.T, action string) string {
	t.Helper()
	space, episode, participant := utilities.ID{}, utilities.ID{}, utilities.ID{}
	for _, id := range []*utilities.ID{&space, &episode, &participant} {
		fresh, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		*id = fresh
	}
	return `{"action":"` + action + `","space_id":"` + space.String() + `","episode_id":"` + episode.String() + `","participant_id":"` + participant.String() + `"}`
}

func TestMCPControlCallIsListedOnlyForAPIKeysThatWriteEpisodes(t *testing.T) {
	cases := []struct {
		name      string
		principal authentication.Principal
		listed    bool
	}{
		{"api key with episodes:write", scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesWrite), true},
		{"api key with episodes:read only", scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesRead), false},
		{"chalk:manage connected app", scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(mcpauth.ScopeManage)...), false},
		{"chalk:read connected app", scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(mcpauth.ScopeRead)...), false},
	}
	for _, test := range cases {
		if got := slices.Contains(toolNames(scopeTestList(t, test.principal)), "chalk_control_call"); got != test.listed {
			t.Errorf("%s: listed=%v want %v", test.name, got, test.listed)
		}
	}
}

func TestMCPControlCallIssuesSyncTokensOnlyToAPIKeysThatWriteEpisodes(t *testing.T) {
	spy := &syncTokenSpy{}
	handler := NewMCPHandler(Options{SyncTokenRefresh: spy, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	arguments := callArguments(t, "sync_token")

	refused := map[string]authentication.Principal{
		"episodes:read key":   scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesRead),
		"chalk:manage app":    scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(mcpauth.ScopeManage)...),
		"chalk:read app":      scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(mcpauth.ScopeRead)...),
		"episodes:delete key": scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesDelete),
	}
	for name, principal := range refused {
		response := callControlCall(t, handler, principal, arguments)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "auth.forbidden") || strings.Contains(response.Body.String(), "sync-secret-fixture") {
			t.Errorf("%s: %d %s", name, response.Code, response.Body.String())
		}
	}
	if len(spy.issued) != 0 {
		t.Fatalf("a refused caller minted %d sync tokens", len(spy.issued))
	}

	writer := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesWrite)
	response := callControlCall(t, handler, writer, arguments)
	body := response.Body.String()
	if response.Code != http.StatusOK || strings.Contains(body, `"isError":true`) || !strings.Contains(body, "sync-secret-fixture") || !strings.Contains(body, "expires_at") {
		t.Fatalf("%d %s", response.Code, body)
	}
	if len(spy.issued) != 1 || spy.issued[0].TenantID != writer.TenantID {
		t.Fatalf("token minted for %+v, want one for tenant %s", spy.issued, writer.TenantID)
	}
}

func TestMCPControlCallActionsNeedTheirFields(t *testing.T) {
	spy := &syncTokenSpy{}
	handler := NewMCPHandler(Options{SyncTokenRefresh: spy, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	writer := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesWrite)
	space, _ := utilities.NewID()
	episode, _ := utilities.NewID()
	base := `"space_id":"` + space.String() + `","episode_id":"` + episode.String() + `"`
	for arguments, want := range map[string]string{
		`{"action":"sync_token",` + base + `}`:                       "also requires: participant_id",
		`{"action":"access_grant",` + base + `}`:                     "also requires: participant_id, participant_generation",
		`{"action":"admit",` + base + `}`:                            "also requires: name, role, request_key",
		`{"action":"mute_everyone",` + base + `}`:                    "action",
		`{"action":"cancel_join",` + base + `,"participant_id":"x"}`: "action",
	} {
		response := callControlCall(t, handler, writer, arguments)
		if !strings.Contains(response.Body.String(), `"isError":true`) || !strings.Contains(response.Body.String(), want) {
			t.Errorf("%s: want error containing %q, got %s", arguments, want, response.Body.String())
		}
	}
	if len(spy.issued) != 0 {
		t.Fatalf("an invalid call minted %d sync tokens", len(spy.issued))
	}
}

func TestMCPConnectionDoesNotListTheDerivedCallCredentialsPermission(t *testing.T) {
	key := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeTenantsRead, authentication.ScopeEpisodesWrite)
	handler := NewMCPHandler(Options{Tenants: tenantProfileStub{}, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(toolCallBody("chalk_get_connection", `{}`)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request.WithContext(authentication.ContextWithPrincipal(request.Context(), key)))
	body := response.Body.String()
	if response.Code != http.StatusOK || !strings.Contains(body, "episodes:write") || strings.Contains(body, "episodes:credentials:issue") {
		t.Fatalf("%d %s", response.Code, body)
	}
}
