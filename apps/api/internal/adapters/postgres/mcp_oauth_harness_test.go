package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	// documents answers client_id metadata document fetches; no test uses the network.
	documents oauthDocuments
}

type oauthDocuments map[string]string

func (d oauthDocuments) Fetch(_ context.Context, clientID string) ([]byte, error) {
	if body, ok := d[clientID]; ok {
		return []byte(body), nil
	}
	return nil, errors.New("no document")
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
	documents := oauthDocuments{}
	oauth := mcpauth.NewService(NewMCPOAuthRepository(pool), mcpauth.Config{Issuer: issuer, ConsentURL: "https://dashboard.example.test/dashboard/connect", Now: clock.Now}).WithMetadataFetcher(documents)
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
	return &oauthHarness{t: t, pool: pool, server: server, clock: clock, tenantA: tenantA, tenantB: tenantB, logs: logs, resource: issuer + "/mcp", documents: documents}
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

func mustHash(t *testing.T, token string) string {
	t.Helper()
	hash, ok := mcpauth.HashAccessToken(token)
	if !ok {
		t.Fatal("bad access token")
	}
	return hash
}
