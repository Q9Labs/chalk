package postgres

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestMCPOAuthFullFlowIsTenantScoped(t *testing.T) {
	h := newOAuthHarness(t)
	clientID := h.register(oauthTestRedirect)
	tokens, _ := h.connect(clientID, oauthTestRedirect, h.tenantA)
	if tokens.TokenType != "Bearer" || tokens.ExpiresIn != 3600 {
		t.Fatalf("token response %+v", tokens)
	}

	session := connectMCP(t, h.server, tokens.AccessToken, "2025-11-25")
	text := mcpText(callMCP(t, session, "inspect_spaces", `{}`))
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
