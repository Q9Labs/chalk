package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	oauthTestService  = "oauth-test-dashboard"
	oauthTestSecret   = "oauth-test-service-secret"
	oauthTestRedirect = "https://claude.ai/api/mcp/auth_callback"
)

type oauthClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *oauthClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *oauthClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type oauthHarness struct {
	t        *testing.T
	pool     sqlcPool
	server   *httptest.Server
	clock    *oauthClock
	tenantA  utilities.ID
	tenantB  utilities.ID
	logs     *bytes.Buffer
	resource string
}

type sqlcPool = sqlc.DBTX

type oauthPKCE struct{ verifier, challenge string }

func newPKCE() oauthPKCE {
	verifier := "verifier-0123456789-0123456789-0123456789-abcdefghij"
	sum := sha256.Sum256([]byte(verifier))
	return oauthPKCE{verifier: verifier, challenge: base64.RawURLEncoding.EncodeToString(sum[:])}
}

func newOAuthHarness(t *testing.T) *oauthHarness {
	t.Helper()
	pool := accountTenantIntegrationPool(t)
	q := sqlc.New(pool)
	logs := &bytes.Buffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	tenantA, tenantB := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	spaceA, spaceB := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	mustExec(t, pool, `insert into tenants(id,name,created_by_service_id) values($1,'OAuth A',$3),($2,'OAuth B',$3)`, uuid(tenantA), uuid(tenantB), oauthTestService)
	mustExec(t, pool, `insert into tenant_artifact_policies(tenant_id) values($1),($2)`, uuid(tenantA), uuid(tenantB))
	mustExec(t, pool, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Alpha OAuth Space',$3,'cf_sfu'),($4,$5,'Beta OAuth Space',$6,'cf_sfu')`, uuid(spaceA), uuid(tenantA), spaceA.String(), uuid(spaceB), uuid(tenantB), spaceB.String())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, statement := range []string{
			`delete from mcp_oauth_grants where tenant_id in ($1,$2)`,
			`delete from spaces where tenant_id in ($1,$2)`,
			`delete from tenant_artifact_policies where tenant_id in ($1,$2)`,
			`delete from tenants where id in ($1,$2)`,
		} {
			if _, err := pool.Exec(ctx, statement, uuid(tenantA), uuid(tenantB)); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
	})

	clock := &oauthClock{now: time.Now()}
	var issuer string
	server := httptest.NewUnstartedServer(nil)
	issuer = "http://" + server.Listener.Addr().String()
	oauth := mcpauth.NewService(NewMCPOAuthRepository(pool), mcpauth.Config{Issuer: issuer, ConsentURL: "https://dashboard.example.test/dashboard/connect", Now: clock.Now})
	options := httpapi.Options{
		OAuth:            oauth,
		TenantAuthz:      authorization.NewTenantPolicy(NewMembershipRepository(q, pool), NewTenantRepository(q)),
		Tenants:          tenants.NewService(NewTenantRepository(q)),
		Spaces:           spaces.NewService(NewSpaceRepository(q, pool)),
		ServicePrincipal: authentication.ServiceCredential{ID: oauthTestService, Secrets: []string{oauthTestSecret}, Scopes: []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite}},
	}
	options.RateLimit.DisableAuthenticated = true
	options.MCP = httpapi.NewMCPHandler(options)
	server.Config.Handler = httpapi.NewRouter(options)
	server.Start()
	t.Cleanup(server.Close)
	return &oauthHarness{t: t, pool: pool, server: server, clock: clock, tenantA: tenantA, tenantB: tenantB, logs: logs, resource: issuer + "/mcp"}
}

func (h *oauthHarness) do(method, path string, headers map[string]string, body string) (*http.Response, string) {
	h.t.Helper()
	request, err := http.NewRequest(method, h.server.URL+path, strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	for k, v := range headers {
		request.Header.Set(k, v)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	return response, string(raw)
}

func (h *oauthHarness) register(redirect string) string {
	h.t.Helper()
	payload, _ := json.Marshal(map[string]any{"client_name": "Test Connector", "redirect_uris": []string{redirect}, "token_endpoint_auth_method": "none"})
	response, body := h.do(http.MethodPost, "/oauth/register", map[string]string{"Content-Type": "application/json"}, string(payload))
	if response.StatusCode != http.StatusCreated {
		h.t.Fatalf("register %s: %d %s", redirect, response.StatusCode, body)
	}
	var out struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil || out.ClientID == "" {
		h.t.Fatalf("register response: %s", body)
	}
	return out.ClientID
}

func (h *oauthHarness) authorizeQuery(clientID, redirect string, pkce oauthPKCE, extra url.Values) url.Values {
	q := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "state": {"state-1"}, "code_challenge": {pkce.challenge}, "code_challenge_method": {"S256"}, "scope": {"chalk:read"}, "resource": {h.resource}}
	if redirect == "" {
		q.Del("redirect_uri") // omitted means the key is absent, not empty
	}
	for k, v := range extra {
		q[k] = v
	}
	return q
}

// authorize starts the flow and returns the consent request handle.
func (h *oauthHarness) authorize(query url.Values) string {
	h.t.Helper()
	response, body := h.do(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil, "")
	if response.StatusCode != http.StatusFound {
		h.t.Fatalf("authorize: %d %s", response.StatusCode, body)
	}
	location, err := url.Parse(response.Header.Get("Location"))
	if err != nil || location.Host != "dashboard.example.test" || location.Query().Get("request") == "" {
		h.t.Fatalf("authorize location %q", response.Header.Get("Location"))
	}
	return location.Query().Get("request")
}

func serviceHeaders() map[string]string {
	return map[string]string{"Authorization": "Bearer " + oauthTestSecret, "Content-Type": "application/json"}
}

func (h *oauthHarness) approve(handle string, tenant utilities.ID, scope string) (*http.Response, string) {
	payload, _ := json.Marshal(map[string]string{"request": handle, "tenant_id": tenant.String(), "scope": scope})
	return h.do(http.MethodPost, "/v1/mcp-oauth/requests/approve", serviceHeaders(), string(payload))
}

// obtainCode runs authorize and approve and returns the authorization code.
func (h *oauthHarness) obtainCode(clientID, redirect string, pkce oauthPKCE, tenant utilities.ID) string {
	h.t.Helper()
	handle := h.authorize(h.authorizeQuery(clientID, redirect, pkce, nil))
	response, body := h.approve(handle, tenant, "chalk:read")
	if response.StatusCode != http.StatusOK {
		h.t.Fatalf("approve: %d %s", response.StatusCode, body)
	}
	var out struct {
		RedirectURL string `json:"redirect_url"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		h.t.Fatal(err)
	}
	location, err := url.Parse(out.RedirectURL)
	if err != nil || !strings.HasPrefix(out.RedirectURL, redirect) || location.Query().Get("state") != "state-1" || location.Query().Get("iss") != h.server.URL {
		h.t.Fatalf("approval redirect %q", out.RedirectURL)
	}
	return location.Query().Get("code")
}

type oauthTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
}

func (h *oauthHarness) token(form url.Values) (int, oauthTokens) {
	h.t.Helper()
	response, body := h.do(http.MethodPost, "/oauth/token", map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, form.Encode())
	var tokens oauthTokens
	_ = json.Unmarshal([]byte(body), &tokens)
	return response.StatusCode, tokens
}

func (h *oauthHarness) exchange(clientID, redirect, code, verifier string) (int, oauthTokens) {
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code}, "code_verifier": {verifier}, "resource": {h.resource}}
	if redirect != "" {
		form.Set("redirect_uri", redirect) // omitted means the key is absent, not empty
	}
	return h.token(form)
}

func (h *oauthHarness) refresh(clientID, refresh string) (int, oauthTokens) {
	return h.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {refresh}, "resource": {h.resource}})
}

func (h *oauthHarness) mcpStatus(accessToken string) int {
	h.t.Helper()
	response, _ := h.do(http.MethodPost, "/mcp", map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}, `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	return response.StatusCode
}

func (h *oauthHarness) connect(clientID, redirect string, tenant utilities.ID) (oauthTokens, string) {
	h.t.Helper()
	pkce := newPKCE()
	code := h.obtainCode(clientID, redirect, pkce, tenant)
	status, tokens := h.exchange(clientID, redirect, code, pkce.verifier)
	if status != http.StatusOK || tokens.AccessToken == "" || tokens.RefreshToken == "" {
		h.t.Fatalf("token exchange: %d %+v", status, tokens)
	}
	return tokens, code
}

func TestMCPOAuthFullFlowIsTenantScoped(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	tokens, _ := h.connect(clientID, oauthTestRedirect, h.tenantA)
	if tokens.TokenType != "Bearer" || tokens.ExpiresIn != 3600 {
		t.Fatalf("token response %+v", tokens)
	}

	session := connectMCP(t, h.server, tokens.AccessToken, "2025-11-25")
	text := mcpText(callMCP(t, session, "list_spaces", `{}`))
	if !strings.Contains(text, "Alpha OAuth Space") || strings.Contains(text, "Beta OAuth Space") {
		t.Fatalf("tenant A grant must see only its own Spaces: %s", text)
	}

	// The same token cannot reach the tenant-scoped /v1 surface.
	response, _ := h.do(http.MethodGet, "/v1/tenants/"+h.tenantA.String()+"/spaces", map[string]string{"Authorization": "Bearer " + tokens.AccessToken}, "")
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("OAuth token on /v1 = %d, want 401", response.StatusCode)
	}

	// Connected apps list and revoke through the dashboard service.
	list, body := h.do(http.MethodGet, "/v1/tenants/"+h.tenantA.String()+"/mcp-connections", serviceHeaders(), "")
	if list.StatusCode != http.StatusOK || !strings.Contains(body, "Test Connector") {
		t.Fatalf("list connections: %d %s", list.StatusCode, body)
	}
	other, body := h.do(http.MethodGet, "/v1/tenants/"+h.tenantB.String()+"/mcp-connections", serviceHeaders(), "")
	if other.StatusCode != http.StatusOK || strings.Contains(body, "Test Connector") {
		t.Fatalf("tenant B must not see tenant A connections: %d %s", other.StatusCode, body)
	}
	var listed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_, raw := h.do(http.MethodGet, "/v1/tenants/"+h.tenantA.String()+"/mcp-connections", serviceHeaders(), "")
	if err := json.Unmarshal([]byte(raw), &listed); err != nil || len(listed.Data) != 1 {
		t.Fatalf("connections %s", raw)
	}
	cross, _ := h.do(http.MethodDelete, "/v1/tenants/"+h.tenantB.String()+"/mcp-connections/"+listed.Data[0].ID, serviceHeaders(), "")
	if cross.StatusCode != http.StatusNotFound || h.mcpStatus(tokens.AccessToken) != http.StatusOK {
		t.Fatalf("revoking through another tenant: %d", cross.StatusCode)
	}
	revoked, _ := h.do(http.MethodDelete, "/v1/tenants/"+h.tenantA.String()+"/mcp-connections/"+listed.Data[0].ID, serviceHeaders(), "")
	if revoked.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %d", revoked.StatusCode)
	}
	if got := h.mcpStatus(tokens.AccessToken); got != http.StatusUnauthorized {
		t.Fatalf("revoked grant still accepted: %d", got)
	}
	if status, _ := h.refresh(clientID, tokens.RefreshToken); status != http.StatusBadRequest {
		t.Fatalf("refresh after revoke = %d", status)
	}
}

func TestMCPOAuthChallengeAndRefusals(t *testing.T) {
	h := newOAuthHarness(t)
	response, _ := h.do(http.MethodPost, "/mcp", nil, `{}`)
	challenge := response.Header.Get("WWW-Authenticate")
	if response.StatusCode != http.StatusUnauthorized || !strings.Contains(challenge, `resource_metadata="`+h.server.URL+`/.well-known/oauth-protected-resource/mcp"`) {
		t.Fatalf("missing challenge: %d %q", response.StatusCode, challenge)
	}
	if got := h.mcpStatus("chalk_oat_" + strings.Repeat("a", 43)); got != http.StatusUnauthorized {
		t.Fatalf("unknown token = %d", got)
	}
	_, metadata := h.do(http.MethodGet, "/.well-known/oauth-protected-resource/mcp", nil, "")
	if !strings.Contains(metadata, h.resource) {
		t.Fatalf("resource metadata %s", metadata)
	}

	// Only the dashboard service may decide consent: no credential and an
	// unrelated bearer both fail.
	for _, headers := range []map[string]string{{"Content-Type": "application/json"}, {"Authorization": "Bearer nope", "Content-Type": "application/json"}} {
		response, _ := h.do(http.MethodPost, "/v1/mcp-oauth/requests/approve", headers, `{"request":"x","tenant_id":"`+h.tenantA.String()+`","scope":"chalk:read"}`)
		if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden {
			t.Fatalf("anonymous approval = %d", response.StatusCode)
		}
	}
}

func TestMCPOAuthRejectsWrongAudience(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	pkce := newPKCE()

	query := h.authorizeQuery(clientID, oauthTestRedirect, pkce, url.Values{"resource": {"https://elsewhere.example.test/mcp"}})
	response, _ := h.do(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil, "")
	location, _ := url.Parse(response.Header.Get("Location"))
	if response.StatusCode != http.StatusFound || location.Query().Get("error") != "invalid_target" || location.Query().Get("code") != "" {
		t.Fatalf("wrong-resource authorize: %d %q", response.StatusCode, response.Header.Get("Location"))
	}

	code := h.obtainCode(clientID, oauthTestRedirect, pkce, h.tenantA)
	status, tokens := h.token(url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code}, "redirect_uri": {oauthTestRedirect}, "code_verifier": {pkce.verifier}, "resource": {"https://elsewhere.example.test/mcp"}})
	if status != http.StatusBadRequest || tokens.AccessToken != "" {
		t.Fatalf("wrong-resource token: %d %+v", status, tokens)
	}

	// A token whose stored audience differs from this server is refused even
	// though its hash is known to the database.
	good, _ := h.connect(clientID, oauthTestRedirect, h.tenantA)
	mustExec(t, h.pool, `update mcp_oauth_tokens set resource='https://elsewhere.example.test/mcp' where token_hash=$1`, mustHash(t, good.AccessToken))
	if got := h.mcpStatus(good.AccessToken); got != http.StatusUnauthorized {
		t.Fatalf("token for another audience = %d", got)
	}
}

func mustHash(t *testing.T, token string) string {
	t.Helper()
	hash, ok := mcpauth.HashAccessToken(token)
	if !ok {
		t.Fatal("bad access token")
	}
	return hash
}

func TestMCPOAuthPKCE(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	pkce := newPKCE()

	for name, extra := range map[string]url.Values{
		"plain method":   {"code_challenge_method": {"plain"}},
		"missing method": {"code_challenge_method": {""}},
		"no challenge":   {"code_challenge": {""}},
	} {
		query := h.authorizeQuery(clientID, oauthTestRedirect, pkce, extra)
		response, _ := h.do(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil, "")
		location, _ := url.Parse(response.Header.Get("Location"))
		if response.StatusCode != http.StatusFound || location.Query().Get("error") != "invalid_request" || !strings.HasPrefix(response.Header.Get("Location"), oauthTestRedirect) {
			t.Fatalf("%s: %d %q", name, response.StatusCode, response.Header.Get("Location"))
		}
	}

	// A wrong verifier fails and burns the code, so the right verifier cannot retry it.
	code := h.obtainCode(clientID, oauthTestRedirect, pkce, h.tenantA)
	if status, _ := h.exchange(clientID, oauthTestRedirect, code, "wrong-verifier-0123456789-0123456789-0123456789-xxxx"); status != http.StatusBadRequest {
		t.Fatalf("wrong verifier = %d", status)
	}
	if status, tokens := h.exchange(clientID, oauthTestRedirect, code, pkce.verifier); status != http.StatusBadRequest || tokens.AccessToken != "" {
		t.Fatalf("code usable after failed verifier: %d", status)
	}
}

func TestMCPOAuthCodesAreSingleUseAndShortLived(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)

	tokens, code := h.connect(clientID, oauthTestRedirect, h.tenantA)
	if h.mcpStatus(tokens.AccessToken) != http.StatusOK {
		t.Fatal("fresh token refused")
	}
	// Replaying a used code is refused and revokes everything that code produced.
	if status, again := h.exchange(clientID, oauthTestRedirect, code, newPKCE().verifier); status != http.StatusBadRequest || again.AccessToken != "" {
		t.Fatalf("code replay: %d", status)
	}
	if got := h.mcpStatus(tokens.AccessToken); got != http.StatusUnauthorized {
		t.Fatalf("grant survived code replay: %d", got)
	}

	pkce := newPKCE()
	expired := h.obtainCode(clientID, oauthTestRedirect, pkce, h.tenantA)
	h.clock.Advance(2 * time.Minute)
	if status, _ := h.exchange(clientID, oauthTestRedirect, expired, pkce.verifier); status != http.StatusBadRequest {
		t.Fatalf("expired code = %d", status)
	}

	// A code is bound to the redirect URI it was issued for.
	other := h.register("https://chatgpt.com/connector_platform_oauth_redirect")
	pkce = newPKCE()
	bound := h.obtainCode(clientID, oauthTestRedirect, pkce, h.tenantA)
	if status, _ := h.exchange(other, oauthTestRedirect, bound, pkce.verifier); status == http.StatusOK {
		t.Fatal("code accepted for another client")
	}
}

func TestMCPOAuthRefreshRotationAndReuse(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	first, _ := h.connect(clientID, oauthTestRedirect, h.tenantA)

	status, second := h.refresh(clientID, first.RefreshToken)
	if status != http.StatusOK || second.RefreshToken == "" || second.RefreshToken == first.RefreshToken || second.AccessToken == first.AccessToken {
		t.Fatalf("rotation: %d %+v", status, second)
	}
	if h.mcpStatus(second.AccessToken) != http.StatusOK {
		t.Fatal("rotated access token refused")
	}

	// Presenting the rotated-out refresh token again signals theft: the grant dies.
	if status, _ := h.refresh(clientID, first.RefreshToken); status != http.StatusBadRequest {
		t.Fatalf("reused refresh token = %d", status)
	}
	if got := h.mcpStatus(second.AccessToken); got != http.StatusUnauthorized {
		t.Fatalf("grant survived refresh reuse: %d", got)
	}
	if status, _ := h.refresh(clientID, second.RefreshToken); status != http.StatusBadRequest {
		t.Fatalf("refresh after reuse = %d", status)
	}

	// Another client cannot redeem this grant's refresh token.
	third, _ := h.connect(clientID, oauthTestRedirect, h.tenantA)
	stranger := h.register("https://chatgpt.com/connector_platform_oauth_redirect")
	if status, _ := h.refresh(stranger, third.RefreshToken); status == http.StatusOK {
		t.Fatal("refresh token redeemed by a different client")
	}
	if got := h.mcpStatus(third.AccessToken); got != http.StatusUnauthorized {
		t.Fatalf("grant survived cross-client refresh: %d", got)
	}
}

func TestMCPOAuthAccessTokensExpireAndRevokeEndpointWorks(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	tokens, _ := h.connect(clientID, oauthTestRedirect, h.tenantA)

	response, _ := h.do(http.MethodPost, "/oauth/revoke", map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, url.Values{"token": {tokens.RefreshToken}, "client_id": {clientID}}.Encode())
	if response.StatusCode != http.StatusOK || h.mcpStatus(tokens.AccessToken) != http.StatusUnauthorized {
		t.Fatalf("revoke endpoint: %d", response.StatusCode)
	}

	again, _ := h.connect(clientID, oauthTestRedirect, h.tenantA)
	h.clock.Advance(61 * time.Minute)
	if got := h.mcpStatus(again.AccessToken); got != http.StatusUnauthorized {
		t.Fatalf("expired access token = %d", got)
	}
	if status, renewed := h.refresh(clientID, again.RefreshToken); status != http.StatusOK || renewed.AccessToken == "" {
		t.Fatalf("refresh after access expiry: %d", status)
	}
}

func TestMCPOAuthRejectsUnsafeRedirects(t *testing.T) {
	h := newOAuthHarness(t)
	for _, redirect := range []string{
		"http://evil.example.test/cb",
		"https://evil.example.test/cb",
		"https://claude.ai/api/mcp/auth_callback/../evil",
		"https://claude.ai.evil.example.test/api/mcp/auth_callback",
		"https://claude.ai/api/mcp/auth_callback#frag",
		"https://user@claude.ai/api/mcp/auth_callback",
		"javascript:alert(1)",
		"https://claude.ai/*",
	} {
		payload, _ := json.Marshal(map[string]any{"client_name": "Evil", "redirect_uris": []string{redirect}})
		response, body := h.do(http.MethodPost, "/oauth/register", map[string]string{"Content-Type": "application/json"}, string(payload))
		if response.StatusCode != http.StatusBadRequest || !strings.Contains(body, "invalid_redirect_uri") {
			t.Errorf("register accepted %q: %d %s", redirect, response.StatusCode, body)
		}
	}

	clientID := h.register(oauthTestRedirect)
	pkce := newPKCE()
	for _, redirect := range []string{"https://evil.example.test/cb", oauthTestRedirect + "?next=https://evil.example.test"} {
		query := h.authorizeQuery(clientID, redirect, pkce, nil)
		response, body := h.do(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil, "")
		if response.StatusCode == http.StatusFound || response.Header.Get("Location") != "" || strings.Contains(body, "evil.example.test/cb?") {
			t.Errorf("authorize redirected an unregistered URI %q: %d %q", redirect, response.StatusCode, response.Header.Get("Location"))
		}
	}
	query := h.authorizeQuery("unknown-client", oauthTestRedirect, pkce, nil)
	if response, _ := h.do(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil, ""); response.Header.Get("Location") != "" {
		t.Errorf("unknown client was redirected to %q", response.Header.Get("Location"))
	}
}

func TestMCPOAuthDenyAndConsentLookup(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	handle := h.authorize(h.authorizeQuery(clientID, oauthTestRedirect, newPKCE(), nil))

	payload, _ := json.Marshal(map[string]string{"request": handle})
	response, body := h.do(http.MethodPost, "/v1/mcp-oauth/requests/inspect", serviceHeaders(), string(payload))
	if response.StatusCode != http.StatusOK || !strings.Contains(body, "Test Connector") || !strings.Contains(body, "claude.ai") {
		t.Fatalf("inspect: %d %s", response.StatusCode, body)
	}

	// Approving more than the app asked for is refused.
	if response, _ := h.approve(handle, h.tenantA, "chalk:manage"); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("scope escalation = %d", response.StatusCode)
	}
	denied, body := h.do(http.MethodPost, "/v1/mcp-oauth/requests/deny", serviceHeaders(), string(payload))
	if denied.StatusCode != http.StatusOK || !strings.Contains(body, "access_denied") {
		t.Fatalf("deny: %d %s", denied.StatusCode, body)
	}
	// A decided request cannot be approved afterwards.
	if response, _ := h.approve(handle, h.tenantA, "chalk:read"); response.StatusCode != http.StatusNotFound {
		t.Fatalf("approve after deny = %d", response.StatusCode)
	}

	// A service may only approve Tenants it created.
	foreign := accountTenantIntegrationID(t)
	mustExec(t, h.pool, `insert into tenants(id,name,created_by_service_id) values($1,'OAuth foreign','someone-else')`, uuid(foreign))
	t.Cleanup(func() { _, _ = h.pool.Exec(context.Background(), `delete from tenants where id=$1`, uuid(foreign)) })
	next := h.authorize(h.authorizeQuery(clientID, oauthTestRedirect, newPKCE(), nil))
	if response, _ := h.approve(next, foreign, "chalk:read"); response.StatusCode != http.StatusForbidden {
		t.Fatalf("approving a Tenant the service did not create = %d", response.StatusCode)
	}
}

func TestMCPOAuthKeepsSecretsOutOfLogs(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	pkce := newPKCE()
	handle := h.authorize(h.authorizeQuery(clientID, oauthTestRedirect, pkce, nil))
	response, body := h.approve(handle, h.tenantA, "chalk:read")
	if response.StatusCode != http.StatusOK {
		t.Fatal(body)
	}
	var approved struct {
		RedirectURL string `json:"redirect_url"`
	}
	_ = json.Unmarshal([]byte(body), &approved)
	redirect, _ := url.Parse(approved.RedirectURL)
	code := redirect.Query().Get("code")
	_, tokens := h.exchange(clientID, oauthTestRedirect, code, pkce.verifier)
	_, rotated := h.refresh(clientID, tokens.RefreshToken)
	h.refresh(clientID, tokens.RefreshToken) // reuse detection logs
	h.exchange(clientID, oauthTestRedirect, code, pkce.verifier)

	logged := h.logs.String()
	for name, secret := range map[string]string{"handle": handle, "code": code, "access": tokens.AccessToken, "refresh": tokens.RefreshToken, "rotated access": rotated.AccessToken, "rotated refresh": rotated.RefreshToken, "verifier": pkce.verifier} {
		if secret != "" && strings.Contains(logged, secret) {
			t.Errorf("%s leaked into logs", name)
		}
	}
	if !strings.Contains(logged, "mcp.oauth.") {
		t.Error("expected mcp.oauth.* log events")
	}
}

func TestMCPOAuthAuthorizeRedirectsOnlyToRegisteredURIs(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	pkce := newPKCE()

	// A rejected request with a registered redirect_uri goes back to exactly that URI.
	query := h.authorizeQuery(clientID, oauthTestRedirect, pkce, url.Values{"response_type": {"token"}})
	response, body := h.do(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil, "")
	location, err := url.Parse(response.Header.Get("Location"))
	if response.StatusCode != http.StatusFound || err != nil || location.Scheme+"://"+location.Host+location.Path != oauthTestRedirect || location.Query().Get("error") != "unsupported_response_type" {
		t.Fatalf("registered redirect error: %d %q %s", response.StatusCode, response.Header.Get("Location"), body)
	}

	// Every lookalike gets an error page and no redirect, even though the request is also invalid.
	for _, attempt := range []string{
		"https://evil.example.test/cb",
		"//evil.example.test/cb",
		"https://claude.ai@evil.example.test/api/mcp/auth_callback",
		"https://claude.ai.evil.example.test/api/mcp/auth_callback",
		"https://CLAUDE.AI/api/mcp/auth_callback",
		"https://claude.ai/api/mcp/auth_callback/",
		"https://claude.ai/api/mcp/auth_callback?next=https://evil.example.test",
		"https://claude.ai/api/mcp/auth_callback#https://evil.example.test",
		"https://claude.ai:444/api/mcp/auth_callback",
		"/api/mcp/auth_callback",
		"javascript:alert(1)",
	} {
		query := h.authorizeQuery(clientID, attempt, pkce, url.Values{"response_type": {"token"}})
		response, body := h.do(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil, "")
		if response.StatusCode != http.StatusBadRequest || response.Header.Get("Location") != "" || strings.Contains(body, "evil.example.test/cb?") {
			t.Errorf("redirect_uri %q: %d Location=%q", attempt, response.StatusCode, response.Header.Get("Location"))
		}
	}

	// A client with several registered URIs only uses the one the request names; omitting it is ambiguous.
	payload, _ := json.Marshal(map[string]any{"client_name": "Two", "redirect_uris": []string{oauthTestRedirect, "http://127.0.0.1/cb"}})
	registered, registeredBody := h.do(http.MethodPost, "/oauth/register", map[string]string{"Content-Type": "application/json"}, string(payload))
	var two struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal([]byte(registeredBody), &two); err != nil || registered.StatusCode != http.StatusCreated {
		t.Fatalf("register two: %d %s", registered.StatusCode, registeredBody)
	}
	query = h.authorizeQuery(two.ClientID, "", pkce, url.Values{"response_type": {"token"}})
	query.Del("redirect_uri")
	if response, _ := h.do(http.MethodGet, "/oauth/authorize?"+query.Encode(), nil, ""); response.Header.Get("Location") != "" {
		t.Errorf("ambiguous redirect_uri was redirected to %q", response.Header.Get("Location"))
	}
}

func TestMCPOAuthConnectionListPagesThroughEveryActiveGrant(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	var clientRow [16]byte
	if err := h.pool.QueryRow(context.Background(), `select id from mcp_oauth_clients where client_id=$1`, clientID).Scan(&clientRow); err != nil {
		t.Fatal(err)
	}
	// 105 grants with only 5 distinct timestamps, so the cursor must break ties on id.
	mustExec(t, h.pool, `insert into mcp_oauth_grants(id,tenant_id,client_id,scopes,resource,approved_by_service_id,created_at)
		select gen_random_uuid(), $1, $2, array['chalk:read'], $3, 'seed', now() - make_interval(mins => g % 5 + 1) from generate_series(1,105) g`,
		uuid(h.tenantA), clientRow, h.resource)
	repository := NewMCPOAuthRepository(accountTenantIntegrationPool(t))

	listAll := func() []mcpauth.Grant {
		var all []mcpauth.Grant
		var cursor *pagination.Cursor
		for pages := 0; pages < 10; pages++ {
			request, err := pagination.NewPageRequest(40, cursor)
			if err != nil {
				t.Fatal(err)
			}
			list, err := repository.ListGrants(context.Background(), h.tenantA, request)
			if err != nil {
				t.Fatal(err)
			}
			all = append(all, list.Grants...)
			if !list.Page.HasMore {
				return all
			}
			cursor = list.Page.NextCursor
		}
		t.Fatal("pagination did not finish")
		return nil
	}

	all := listAll()
	seen := make(map[utilities.ID]bool, len(all))
	for i, grant := range all {
		if seen[grant.ID] {
			t.Fatalf("grant %s listed twice", grant.ID)
		}
		seen[grant.ID] = true
		if i > 0 && grant.CreatedAt.After(all[i-1].CreatedAt) {
			t.Fatalf("grants out of order at %d", i)
		}
	}
	if len(all) != 105 {
		t.Fatalf("paged through %d active grants, want all 105", len(all))
	}

	// The oldest grant is reachable and revocable, and then it disappears from the list.
	oldest := all[len(all)-1]
	if err := repository.RevokeTenantGrant(context.Background(), h.tenantA, oldest.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, grant := range listAll() {
		if grant.ID == oldest.ID {
			t.Fatal("revoked grant is still listed")
		}
	}
}

// RFC 6749 section 4.1.3: the token request repeats redirect_uri only if the
// authorization request carried it.
func TestMCPOAuthRedirectURIFollowsTheAuthorizationRequest(t *testing.T) {
	h := newOAuthHarness(t)
	const second = "http://127.0.0.1/cb"
	payload, _ := json.Marshal(map[string]any{"client_name": "Two", "redirect_uris": []string{oauthTestRedirect, second}})
	_, registered := h.do(http.MethodPost, "/oauth/register", map[string]string{"Content-Type": "application/json"}, string(payload))
	var two struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal([]byte(registered), &two); err != nil {
		t.Fatal(err)
	}
	single := h.register(oauthTestRedirect)

	cases := []struct {
		name      string
		client    string
		authorize string // redirect_uri sent to /authorize; empty means omitted
		token     string // redirect_uri sent to /oauth/token; empty means omitted
		want      int
	}{
		{"supplied then identical", two.ClientID, oauthTestRedirect, oauthTestRedirect, http.StatusOK},
		{"supplied then omitted", two.ClientID, oauthTestRedirect, "", http.StatusBadRequest},
		{"supplied then another registered URI", two.ClientID, oauthTestRedirect, second, http.StatusBadRequest},
		{"supplied then an unregistered URI", two.ClientID, oauthTestRedirect, "https://evil.example.test/cb", http.StatusBadRequest},
		{"omitted then omitted", single, "", "", http.StatusOK},
		{"omitted then the single registered URI", single, "", oauthTestRedirect, http.StatusOK},
		{"omitted then an unregistered URI", single, "", "https://evil.example.test/cb", http.StatusBadRequest},
	}
	for _, c := range cases {
		pkce := newPKCE()
		code := h.obtainCode(c.client, c.authorize, pkce, h.tenantA)
		if status, tokens := h.exchange(c.client, c.token, code, pkce.verifier); status != c.want || (c.want == http.StatusOK) != (tokens.AccessToken != "") {
			t.Errorf("%s: token request = %d, want %d", c.name, status, c.want)
		}
	}
}

// RFC 6749 section 3.1: a parameter sent without a value is treated as omitted.
func TestMCPOAuthEmptyRedirectURIIsTreatedAsOmitted(t *testing.T) {
	h := newOAuthHarness(t)
	single := h.register(oauthTestRedirect)

	// Empty at /authorize counts as omitted, so the token request may omit it, send it empty or name the registered URI.
	for _, token := range []url.Values{{}, {"redirect_uri": {""}}, {"redirect_uri": {oauthTestRedirect}}} {
		pkce := newPKCE()
		query := h.authorizeQuery(single, "", pkce, url.Values{"redirect_uri": {""}})
		handle := h.authorize(query)
		response, body := h.approve(handle, h.tenantA, "chalk:read")
		var out struct {
			RedirectURL string `json:"redirect_url"`
		}
		if err := json.Unmarshal([]byte(body), &out); err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("approve: %d %s", response.StatusCode, body)
		}
		location, _ := url.Parse(out.RedirectURL)
		form := url.Values{"grant_type": {"authorization_code"}, "client_id": {single}, "code": {location.Query().Get("code")}, "code_verifier": {pkce.verifier}, "resource": {h.resource}}
		for k, v := range token {
			form[k] = v
		}
		if status, tokens := h.token(form); status != http.StatusOK || tokens.AccessToken == "" {
			t.Errorf("token form %v after empty redirect_uri: %d", token, status)
		}
	}

	// Empty at the token endpoint does not satisfy a redirect_uri the authorization request supplied.
	pkce := newPKCE()
	code := h.obtainCode(single, oauthTestRedirect, pkce, h.tenantA)
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {single}, "code": {code}, "redirect_uri": {""}, "code_verifier": {pkce.verifier}, "resource": {h.resource}}
	if status, _ := h.token(form); status != http.StatusBadRequest {
		t.Errorf("empty redirect_uri after a supplied one = %d, want 400", status)
	}
}
