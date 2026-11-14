package utilities

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestSecretFieldName(t *testing.T) {
	secrets := []string{
		"secret", "token", "private_key", "api_key", "apiKey", "API-KEY", "api token", "app_secret", "clientSecret",
		"credential", "credentials", "secret_key", "auth", "Authorization", "auth_header", "authorization_header",
		"access_token", "refresh_token", "bearer_token", "secret_access_key", "password", "db_password", "dbPassword",
		"stripe_secret", "x_api_key", "service_account_credentials", "PrivateKey", "aws_secret_access_key", "authToken",
	}
	for _, name := range secrets {
		if !SecretFieldName(name) {
			t.Errorf("%q must be treated as a secret", name)
		}
	}
	plain := []string{"", "name", "url", "region", "bucket", "tokens_per_minute", "author", "authority", "public_key", "key", "id", "secretary"}
	for _, name := range plain {
		if SecretFieldName(name) {
			t.Errorf("%q must not be treated as a secret", name)
		}
	}
}

func TestRedactSecretsWalksNestedValues(t *testing.T) {
	got := RedactSecrets(map[string]any{
		"region": "r", "api_key": "k",
		"nested": []any{map[string]any{"password": "p", "ok": 1}},
	})
	want := map[string]any{
		"region": "r", "api_key": RedactedValue,
		"nested": []any{map[string]any{"password": RedactedValue, "ok": 1}},
	}
	if !slices.Equal([]string{toJSON(got)}, []string{toJSON(want)}) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func toJSON(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}
