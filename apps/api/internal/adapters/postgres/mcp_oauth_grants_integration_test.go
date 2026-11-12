package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
