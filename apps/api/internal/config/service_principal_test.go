package config

import (
	"reflect"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

const (
	testServiceSecretA = "service-a-secret-0123456789abcdef"
	testServiceSecretB = "service-b-secret-0123456789abcdef"
)

func clearServicePrincipalEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv(APIServiceID, "")
	t.Setenv(APIServiceSecrets, "")
	t.Setenv(APIServiceScopes, "")
	t.Setenv(APIServicePrincipals, "")
}

func TestLoadServicePrincipalsKeepsLegacyConfiguration(t *testing.T) {
	clearServicePrincipalEnvironment(t)
	t.Setenv(APIServiceID, "dashboard")
	t.Setenv(APIServiceSecrets, testServiceSecretA)
	t.Setenv(APIServiceScopes, "tenants:read,tenants:write")

	credentials, err := loadServicePrincipals("")
	if err != nil {
		t.Fatal(err)
	}
	if len(credentials) != 1 {
		t.Fatalf("credentials=%d, want 1", len(credentials))
	}
	credential := credentials[0]
	if credential.ID != "dashboard" || !credential.Dashboard {
		t.Fatalf("legacy credential=%#v, want dashboard service", credential)
	}
	if !reflect.DeepEqual(credential.Secrets, []string{testServiceSecretA}) {
		t.Fatalf("legacy secrets=%#v", credential.Secrets)
	}
	if !reflect.DeepEqual(credential.Scopes, []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite}) {
		t.Fatalf("legacy scopes=%#v", credential.Scopes)
	}
}

func TestLoadServicePrincipalsParsesRegisteredServices(t *testing.T) {
	clearServicePrincipalEnvironment(t)
	t.Setenv(APIServicePrincipals, `[
		{"id":"service-a","secrets":["`+testServiceSecretA+`"],"scopes":["tenants:read"],"dashboard":true},
		{"id":"service-b","secrets":["`+testServiceSecretB+`","`+testServiceSecretB+`-next"],"scopes":["tenants:read","tenants:write"]}
	]`)

	credentials, err := loadServicePrincipals("")
	if err != nil {
		t.Fatal(err)
	}
	if len(credentials) != 2 {
		t.Fatalf("credentials=%d, want 2", len(credentials))
	}
	if credentials[0].ID != "service-a" || !credentials[0].Dashboard {
		t.Fatalf("first credential=%#v", credentials[0])
	}
	if credentials[1].ID != "service-b" || credentials[1].Dashboard {
		t.Fatalf("second credential=%#v", credentials[1])
	}
	if !reflect.DeepEqual(credentials[1].Secrets, []string{testServiceSecretB, testServiceSecretB + "-next"}) {
		t.Fatalf("second secrets=%#v", credentials[1].Secrets)
	}
	if !reflect.DeepEqual(credentials[1].Scopes, []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite}) {
		t.Fatalf("second scopes=%#v", credentials[1].Scopes)
	}
}

func TestLoadServicePrincipalsCombinesLegacyDashboardWithRegisteredServices(t *testing.T) {
	clearServicePrincipalEnvironment(t)
	t.Setenv(APIServiceID, "dashboard")
	t.Setenv(APIServiceSecrets, testServiceSecretA)
	t.Setenv(APIServiceScopes, "tenants:read")
	t.Setenv(APIServicePrincipals, `[{"id":"service-b","secrets":["`+testServiceSecretB+`"],"scopes":["tenants:write"]}]`)

	credentials, err := loadServicePrincipals("")
	if err != nil {
		t.Fatal(err)
	}
	if len(credentials) != 2 || credentials[0].ID != "dashboard" || !credentials[0].Dashboard || credentials[1].ID != "service-b" || credentials[1].Dashboard {
		t.Fatalf("credentials=%#v", credentials)
	}
}

func TestLoadServicePrincipalsRejectsAmbiguousOrInvalidConfiguration(t *testing.T) {
	validService := `{"id":"service-b","secrets":["` + testServiceSecretB + `"],"scopes":["tenants:read"]}`
	for name, setup := range map[string]func(t *testing.T){
		"legacy partial": func(t *testing.T) {
			t.Setenv(APIServiceID, "dashboard")
		},
		"malformed json": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[{"id":"service-b"`)
		},
		"unknown field": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[{"id":"service-b","secrets":["`+testServiceSecretB+`"],"scopes":["tenants:read"],"extra":true}]`)
		},
		"empty list": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[]`)
		},
		"duplicate service id": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[`+validService+`,`+validService+`]`)
		},
		"shared secret across services": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[
				{"id":"service-a","secrets":["`+testServiceSecretA+`"],"scopes":["tenants:read"]},
				{"id":"service-b","secrets":["`+testServiceSecretA+`"],"scopes":["tenants:read"]}
			]`)
		},
		"two dashboard services": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[
				{"id":"service-a","secrets":["`+testServiceSecretA+`"],"scopes":["tenants:read"],"dashboard":true},
				{"id":"service-b","secrets":["`+testServiceSecretB+`"],"scopes":["tenants:read"],"dashboard":true}
			]`)
		},
		"legacy id repeated": func(t *testing.T) {
			t.Setenv(APIServiceID, "dashboard")
			t.Setenv(APIServiceSecrets, testServiceSecretA)
			t.Setenv(APIServiceScopes, "tenants:read")
			t.Setenv(APIServicePrincipals, `[{"id":"dashboard","secrets":["`+testServiceSecretB+`"],"scopes":["tenants:read"]}]`)
		},
		"second dashboard with legacy": func(t *testing.T) {
			t.Setenv(APIServiceID, "dashboard")
			t.Setenv(APIServiceSecrets, testServiceSecretA)
			t.Setenv(APIServiceScopes, "tenants:read")
			t.Setenv(APIServicePrincipals, `[{"id":"service-b","secrets":["`+testServiceSecretB+`"],"scopes":["tenants:read"],"dashboard":true}]`)
		},
		"invalid scope": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[{"id":"service-b","secrets":["`+testServiceSecretB+`"],"scopes":["tenant:read"]}]`)
		},
		"short secret": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[{"id":"service-b","secrets":["short"],"scopes":["tenants:read"]}]`)
		},
		"system token overlap": func(t *testing.T) {
			t.Setenv(APIServicePrincipals, `[{"id":"service-b","secrets":["`+testServiceSecretB+`"],"scopes":["tenants:read"]}]`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			clearServicePrincipalEnvironment(t)
			setup(t)
			systemToken := ""
			if name == "system token overlap" {
				systemToken = testServiceSecretB
			}
			if _, err := loadServicePrincipals(systemToken); err == nil || !strings.Contains(err.Error(), "CHALK_API_SERVICE") {
				t.Fatalf("error=%v, want service configuration rejection", err)
			}
		})
	}
}
