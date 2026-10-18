package config

import (
	"strings"
	"testing"
)

func TestServicePrincipalConfigurationIsOptInAndFailClosed(t *testing.T) {
	for _, test := range []struct {
		name, id, secrets, scopes string
		invalid                   bool
	}{
		{name: "disabled"},
		{name: "enabled", id: "dashboard", secrets: strings.Repeat("a", 32) + "," + strings.Repeat("b", 32), scopes: "tenants:read,tenants:write"},
		{name: "missing ID", secrets: strings.Repeat("a", 32), scopes: "tenants:read", invalid: true},
		{name: "missing secret", id: "dashboard", scopes: "tenants:read", invalid: true},
		{name: "missing scopes", id: "dashboard", secrets: strings.Repeat("a", 32), invalid: true},
		{name: "unknown scope", id: "dashboard", secrets: strings.Repeat("a", 32), scopes: "*", invalid: true},
		{name: "short secret", id: "dashboard", secrets: "short", scopes: "tenants:read", invalid: true},
		{name: "short multibyte secret", id: "dashboard", secrets: strings.Repeat("😀", 8), scopes: "tenants:read", invalid: true},
		{name: "invalid UTF-8 secret", id: "dashboard", secrets: strings.Repeat("\xff", 32), scopes: "tenants:read", invalid: true},
		{name: "multibyte secret of 32 characters", id: "dashboard", secrets: strings.Repeat("😀", 32), scopes: "tenants:read"},
		{name: "API key collision", id: "dashboard", secrets: "chalk_sk_" + strings.Repeat("a", 32), scopes: "tenants:read", invalid: true},
		{name: "system collision", id: "dashboard", secrets: strings.Repeat("s", 32), scopes: "tenants:read", invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(APIServiceID, test.id)
			t.Setenv(APIServiceSecrets, test.secrets)
			t.Setenv(APIServiceScopes, test.scopes)
			credential, err := loadServicePrincipal(strings.Repeat("s", 32))
			if (err != nil) != test.invalid {
				t.Fatalf("load error = %v, want invalid=%t", err, test.invalid)
			}
			if !test.invalid && credential.ID != test.id {
				t.Fatalf("service ID = %q", credential.ID)
			}
			if test.name == "enabled" && (len(credential.Secrets) != 2 || len(credential.Scopes) != 2) {
				t.Fatalf("rotation/scopes not loaded")
			}
		})
	}
}
