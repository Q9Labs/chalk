package mcpauth

import "testing"

func TestValidRedirectURIAcceptsOnlyKnownConnectorsAndLoopback(t *testing.T) {
	config := Config{ExtraRedirectURIs: []string{"https://operator.example/callback"}}
	for _, test := range []struct {
		uri  string
		want bool
	}{
		{"https://claude.ai/api/mcp/auth_callback", true},
		{"https://claude.com/api/mcp/auth_callback", true},
		{"https://api.devin.ai/mcp/oauth/callback", true},
		{"https://chatgpt.com/connector_platform_oauth_redirect", true},
		{"https://chatgpt.com/connector/oauth/abc_123", true},
		{"http://localhost/callback", true},
		{"http://127.0.0.1/callback", true},
		{"https://operator.example/callback", true},
		{"https://claude.ai/other", false},
		{"https://evil.example/api/mcp/auth_callback", false},
		{"http://example.com/callback", false},
		{"http://localhost/a/../b", false},
		{"https://claude.ai:8443/api/mcp/auth_callback", false},
		{"https://claude.ai/api/mcp/auth_callback#frag", false},
		{"", false},
	} {
		if got := config.validRedirectURI(test.uri); got != test.want {
			t.Errorf("validRedirectURI(%q) = %v, want %v", test.uri, got, test.want)
		}
	}
}

func TestValidMetadataURLRequiresCleanHTTPSPath(t *testing.T) {
	for _, test := range []struct {
		uri string
		ok  bool
	}{
		{"https://client.example/metadata.json", true},
		{"https://client.example/", false},
		{"https://client.example", false},
		{"http://client.example/metadata.json", false},
		{"https://client.example:8443/metadata.json", false},
		{"https://user@client.example/metadata.json", false},
		{"https://client.example/a/../metadata.json", false},
		{"https://client.example/metadata.json?x=1", false},
		{"https://client.example/metadata.json#x", false},
		{"https://203.0.113.5/metadata.json", false},
	} {
		if err := validMetadataURL(test.uri); (err == nil) != test.ok {
			t.Errorf("validMetadataURL(%q) error = %v, want ok=%v", test.uri, err, test.ok)
		}
	}
}
