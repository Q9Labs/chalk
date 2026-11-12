package postgres

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

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

func TestMCPOAuthClientIDMetadataDocuments(t *testing.T) {
	h := newOAuthHarness(t)
	_, metadata := h.do(http.MethodGet, "/.well-known/oauth-authorization-server", nil, "")
	if !strings.Contains(metadata, `"client_id_metadata_document_supported":true`) {
		t.Fatalf("authorization server metadata does not advertise client ID metadata documents: %s", metadata)
	}
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	clientID := "https://claude.ai/oauth/" + h.tenantA.String()
	h.documents[clientID] = `{"client_id":"` + clientID + `","client_name":"Claude (CIMD)","redirect_uris":["` + redirect + `"],"token_endpoint_auth_method":"none"}`

	tokens, _ := h.connect(clientID, redirect, h.tenantA)
	if h.mcpStatus(tokens.AccessToken) != http.StatusOK {
		t.Fatal("a token issued to a metadata-document client must reach /mcp")
	}
	if status, rotated := h.refresh(clientID, tokens.RefreshToken); status != http.StatusOK || rotated.AccessToken == "" {
		t.Fatalf("refresh for a metadata-document client: %d %+v", status, rotated)
	}

	// A document that names a redirect outside the allowlist, or the wrong client_id, never reaches consent.
	hostile := "https://claude.ai/oauth/hostile"
	h.documents[hostile] = `{"client_id":"` + hostile + `","client_name":"Claude","redirect_uris":["https://evil.example.test/cb"]}`
	mismatch := "https://claude.ai/oauth/mismatch"
	h.documents[mismatch] = `{"client_id":"https://claude.ai/oauth/other","client_name":"Claude","redirect_uris":["` + redirect + `"]}`
	for _, id := range []string{hostile, mismatch, "https://claude.ai/oauth/missing"} {
		response, body := h.do(http.MethodGet, "/oauth/authorize?"+h.authorizeQuery(id, redirect, newPKCE(), nil).Encode(), nil, "")
		if response.StatusCode != http.StatusBadRequest || response.Header.Get("Location") != "" {
			t.Errorf("%s: %d %q %s", id, response.StatusCode, response.Header.Get("Location"), body)
		}
	}
}
