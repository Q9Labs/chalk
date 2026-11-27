package config

import (
	"reflect"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func TestLoadServicePrincipals(t *testing.T) {
	const dashboardSecret = "test-dashboard-secret-0123456789"
	const serviceSecret = "test-service-secret-012345678901"
	const rotatedSecret = "test-service-rotation-0123456789"
	const additional = `[{"id":"service-b","secrets":["` + serviceSecret + `","` + rotatedSecret + `"],"scopes":["tenants:read","transcriptions:write"]}]`
	t.Setenv(APIServiceID, "dashboard")
	t.Setenv(APIServiceSecrets, dashboardSecret)
	t.Setenv(APIServiceScopes, "tenants:read, tenants:write")

	dashboard := authentication.ServiceCredential{ID: "dashboard", Secrets: []string{dashboardSecret}, Scopes: []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite}}
	service := authentication.ServiceCredential{ID: "service-b", Secrets: []string{serviceSecret, rotatedSecret}, Scopes: []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTranscriptionsWrite}}
	for _, test := range []struct {
		name, json, dashboardID string
		want                    []authentication.ServiceCredential
	}{
		{"legacy only", "", "dashboard", []authentication.ServiceCredential{dashboard}},
		{"legacy and additional", additional, "dashboard", []authentication.ServiceCredential{dashboard, service}},
		{"additional only", additional, "", []authentication.ServiceCredential{service}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.dashboardID == "" {
				t.Setenv(APIServiceID, "")
				t.Setenv(APIServiceSecrets, "")
				t.Setenv(APIServiceScopes, "")
			}
			t.Setenv(APIServicePrincipals, test.json)
			got, dashboardID, err := loadServicePrincipals("")
			if err != nil || dashboardID != test.dashboardID || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("unexpected service config: dashboard=%q, credentials match=%v, error=%v", dashboardID, reflect.DeepEqual(got, test.want), err)
			}
		})
	}
	for _, test := range []struct {
		name, json, systemToken string
	}{
		{"malformed JSON", `[{"secrets":["` + serviceSecret + `"]}`, ""},
		{"trailing JSON", additional + ` []`, ""},
		{"null", "null", ""},
		{"unknown field", strings.Replace(additional, `"id"`, `"identifier"`, 1), ""},
		{"missing scopes", strings.Replace(additional, `["tenants:read","transcriptions:write"]`, "[]", 1), ""},
		{"unrecognized scope", strings.Replace(additional, "transcriptions:write", "transcripts:write", 1), ""},
		{"duplicate dashboard ID", strings.Replace(additional, "service-b", "dashboard", 1), ""},
		{"duplicate additional ID", additional[:len(additional)-1] + "," + additional[1:], ""},
		{"shared dashboard secret", strings.Replace(additional, serviceSecret, dashboardSecret, 1), ""},
		{"shared additional secret", additional[:len(additional)-1] + "," + strings.Replace(additional[1:], "service-b", "service-c", 1), ""},
		{"local System secret", additional, serviceSecret},
		{"short secret", strings.Replace(additional, serviceSecret, "short", 1), ""},
		{"secret with whitespace", strings.Replace(additional, serviceSecret, serviceSecret+" ", 1), ""},
		{"secret with Unicode whitespace", strings.Replace(additional, serviceSecret, serviceSecret+"\u00a0", 1), ""},
		{"secret padded to match another", additional[:len(additional)-1] + "," + strings.Replace(strings.Replace(additional[1:], "service-b", "service-c", 1), serviceSecret, "\u2003"+serviceSecret, 1), ""},
		{"case-variant field", strings.Replace(additional, `"id"`, `"ID"`, 1), ""},
		{"duplicate field", strings.Replace(additional, `"id":"service-b"`, `"id":"service-b","id":"service-c"`, 1), ""},
		{"case-variant duplicate field", strings.Replace(additional, `"id":"service-b"`, `"id":"service-b","Id":"service-c"`, 1), ""},
		{"entry is not an object", `[null]`, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(APIServicePrincipals, test.json)
			_, _, err := loadServicePrincipals(test.systemToken)
			if err == nil || !strings.Contains(err.Error(), APIServicePrincipals) {
				t.Fatalf("want a %s configuration error, got %v", APIServicePrincipals, err)
			}
			for _, secret := range []string{dashboardSecret, serviceSecret, rotatedSecret} {
				if strings.Contains(err.Error(), secret) {
					t.Fatal("configuration error leaked a secret")
				}
			}
		})
	}
}
