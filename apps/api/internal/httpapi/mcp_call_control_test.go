package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
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

// An action call that lacks the fields its action needs is a tool error that names the missing
// field, and mints nothing.
func TestMCPControlCallActionsNeedTheirFields(t *testing.T) {
	spy := &syncTokenSpy{}
	handler := NewMCPHandler(Options{SyncTokenRefresh: spy, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	writer := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesWrite)
	space, _ := utilities.NewID()
	episode, _ := utilities.NewID()
	base := `"space_id":"` + space.String() + `","episode_id":"` + episode.String() + `"`
	for arguments, field := range map[string]string{
		`{"action":"sync_token",` + base + `}`:                                            "participant_id",
		`{"action":"access_grant",` + base + `}`:                                          "participant_id",
		`{"action":"admit",` + base + `}`:                                                 "name",
		`{"action":"mute_everyone",` + base + `}`:                                         "action",
		`{"action":"cancel_join",` + base + `,"participant_id":"` + space.String() + `"}`: "action",
	} {
		response := callControlCall(t, handler, writer, arguments)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"isError":true`) || !strings.Contains(response.Body.String(), field) {
			t.Errorf("%s: want a tool error naming %s, got %d %s", arguments, field, response.Code, response.Body.String())
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

// ownSFUGrantHandler serves an Episode bound to the own SFU, with the issuer and verifier the REST route uses.
func ownSFUGrantHandler(t *testing.T, principal authentication.Principal, lifecycle EpisodeLifecycleService) (http.Handler, *chalkGrantPlane, accessgrants.Subject) {
	t.Helper()
	subject := participantMediaSubject(t)
	subject.TenantID = principal.TenantID
	repo := &refreshGrantRepository{current: synctokens.Input{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration}}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"key": public}})
	if err != nil {
		t.Fatal(err)
	}
	fixture := &chalkGrantPlane{recoveryGrantPlane{refreshGrantPlane{issuer: issuer}}}
	active := accessgrants.NewActiveAuthorizer(repo)
	return NewMCPHandler(Options{Episodes: lifecycle, SyncTokenRefresh: fixture, ParticipantMediaIssuer: fixture, ParticipantMediaVerify: verifier, ParticipantMediaActive: active, ParticipantGeneration: active, Spaces: fixture, Tenants: fixture, MediaPlane: fixture, TenantAuthz: authorization.NewTenantPolicy(nil, nil)}), fixture, subject
}

func TestMCPControlCallWorksOnOwnSFUEpisodes(t *testing.T) {
	writer := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesWrite)
	lifecycle := &admissionRecorder{}
	handler, fixture, subject := ownSFUGrantHandler(t, writer, lifecycle)
	base := `"space_id":"` + subject.SpaceID.String() + `","episode_id":"` + subject.EpisodeID.String() + `"`

	admit := callControlCall(t, handler, writer, `{"action":"admit",`+base+`,"name":"Hana","role":"collaborator","request_key":"mcp-call-admit-0001"}`)
	if lifecycle.admitted != 1 || strings.Contains(admit.Body.String(), "media.client_unsupported") {
		t.Fatalf("admit into an own-SFU Episode: %d admissions, %s", lifecycle.admitted, admit.Body.String())
	}

	grant := callControlCall(t, handler, writer, `{"action":"access_grant",`+base+`,"participant_id":"`+subject.ParticipantID.String()+`","participant_generation":7,"replace_media_connection":true}`)
	if fixture.created != 1 || strings.Contains(grant.Body.String(), "media.client_unsupported") {
		t.Fatalf("access grant for an own-SFU Episode: %d joins, %s", fixture.created, grant.Body.String())
	}
}

func TestMCPControlCallRejectsAnEmptyConnectionFence(t *testing.T) {
	writer := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesWrite)
	handler, fixture, subject := ownSFUGrantHandler(t, writer, &admissionRecorder{})
	base := `{"action":"access_grant","space_id":"` + subject.SpaceID.String() + `","episode_id":"` + subject.EpisodeID.String() + `","participant_id":"` + subject.ParticipantID.String() + `","participant_generation":7`
	for _, tail := range []string{
		`,"replace_media_connection":true,"expected_media_connection_id":""}`,
		`,"replace_media_connection":true,"expected_media_connection_id":"  "}`,
		`,"replace_media_connection":false,"expected_media_connection_id":""}`,
	} {
		response := callControlCall(t, handler, writer, base+tail)
		if !strings.Contains(response.Body.String(), `"isError":true`) {
			t.Errorf("%s: an empty fence was accepted: %s", tail, response.Body.String())
		}
	}
	if fixture.created != 0 {
		t.Fatalf("an empty fence reserved %d own-SFU joins", fixture.created)
	}
}
