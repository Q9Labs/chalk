package mcpauth

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func TestRedirectAllowlist(t *testing.T) {
	config := Config{ExtraRedirectURIs: []string{"https://app.example.test/oauth/callback"}}
	allowed := []string{
		"https://claude.ai/api/mcp/auth_callback",
		"https://claude.com/api/mcp/auth_callback",
		"https://chatgpt.com/connector_platform_oauth_redirect",
		"https://chatgpt.com/connector/oauth/abc_DEF-123",
		"http://localhost:8123/callback",
		"http://127.0.0.1:9000/cb",
		"https://app.example.test/oauth/callback",
	}
	for _, uri := range allowed {
		if !config.validRedirectURI(uri) {
			t.Errorf("rejected %q", uri)
		}
	}
	refused := []string{
		"",
		"http://claude.ai/api/mcp/auth_callback",
		"https://claude.ai/api/mcp/auth_callback/",
		"https://claude.ai/api/mcp/auth_callback?x=1",
		"https://claude.ai/api/mcp/auth_callback#f",
		"https://claude.ai:8443/api/mcp/auth_callback",
		"https://claude.ai.evil.test/api/mcp/auth_callback",
		"https://evilclaude.ai/api/mcp/auth_callback",
		"https://user@claude.ai/api/mcp/auth_callback",
		"https://chatgpt.com/connector/oauth/../x",
		"https://chatgpt.com/other",
		"http://evil.test/cb",
		"http://localhost.evil.test/cb",
		"http://localhost",
		"javascript:alert(1)",
		"https://app.example.test/oauth/callback2",
		"https://claude.ai/api/mcp/auth_callback\\@evil.test",
		"https://" + strings.Repeat("a", 600) + ".test/",
	}
	for _, uri := range refused {
		if config.validRedirectURI(uri) {
			t.Errorf("accepted %q", uri)
		}
	}
}

func TestPKCE(t *testing.T) {
	verifier := strings.Repeat("v", 43)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	if !verifyPKCE(verifier, challenge) {
		t.Fatal("valid pair refused")
	}
	for name, v := range map[string]string{"wrong": strings.Repeat("w", 43), "short": "short", "empty": "", "plain challenge": challenge, "reserved": strings.Repeat("v", 42) + "!"} {
		if verifyPKCE(v, challenge) {
			t.Errorf("%s verifier accepted", name)
		}
	}
	if verifyPKCE(verifier, verifier) {
		t.Error("plain (verifier equals challenge) accepted")
	}
	if validCodeChallenge("tooshort") || !validCodeChallenge(challenge) {
		t.Error("challenge validation wrong")
	}
}

func TestTokensAreHashedAndPrefixed(t *testing.T) {
	raw, hash, err := newSecret(AccessTokenPrefix)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(raw, AccessTokenPrefix) || hash == raw || strings.Contains(hash, raw) {
		t.Fatalf("token %q hash %q", raw, hash)
	}
	if got, ok := HashAccessToken(raw); !ok || got != hash {
		t.Fatal("access token hash is not reproducible")
	}
	if _, ok := HashAccessToken("chalk_sk_" + strings.Repeat("a", 43)); ok {
		t.Fatal("API key accepted as an access token")
	}
}

func TestScopeBundlesExcludeCredentialsAndMembers(t *testing.T) {
	if NormalizeScope("") != ScopeRead || NormalizeScope("bogus chalk:manage") != ScopeManage && NormalizeScope("bogus chalk:manage") != ScopeRead {
		t.Fatalf("normalize: %q %q", NormalizeScope(""), NormalizeScope("bogus chalk:manage"))
	}
	if ApprovalAllowed(ScopeRead, ScopeManage) || !ApprovalAllowed(ScopeManage, ScopeRead) {
		t.Fatal("approval may only narrow the request")
	}
	forbidden := []authentication.Scope{authentication.ScopeAPIKeysRead, authentication.ScopeAPIKeysWrite, authentication.ScopeSigningKeysRead, authentication.ScopeTenantsWrite, authentication.ScopeMembershipsRead, authentication.ScopeMembershipsWrite, authentication.ScopeWebhooksDelete, authentication.ScopeSpacesDelete}
	for _, bundle := range []string{ScopeRead, ScopeManage} {
		granted := AuthenticationScopes(bundle)
		if len(granted) == 0 {
			t.Fatalf("%s grants nothing", bundle)
		}
		for _, scope := range granted {
			for _, no := range forbidden {
				if scope == no {
					t.Errorf("%s grants %s", bundle, scope)
				}
			}
		}
	}
}
