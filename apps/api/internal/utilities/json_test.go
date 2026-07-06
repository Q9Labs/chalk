package utilities_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestOptionalNullableJSONKeepsOmitted(t *testing.T) {
	value, err := utilities.OptionalNullableJSON(utilities.OptionalJSON{})
	if err != nil {
		t.Fatalf("optional json: %v", err)
	}

	if value.Set {
		t.Fatal("set = true, want false")
	}
	if value.Value != nil {
		t.Fatalf("value = %s, want nil", value.Value)
	}
}

func TestOptionalNullableJSONKeepsNull(t *testing.T) {
	value, err := utilities.OptionalNullableJSON(utilities.OptionalJSON{Set: true})
	if err != nil {
		t.Fatalf("optional json: %v", err)
	}

	if !value.Set {
		t.Fatal("set = false, want true")
	}
	if value.Value != nil {
		t.Fatalf("value = %s, want nil", value.Value)
	}
}

func TestOptionalNullableJSONRejectsInvalidJSON(t *testing.T) {
	_, err := utilities.OptionalNullableJSON(utilities.OptionalJSON{
		Set:   true,
		Value: json.RawMessage(`{"broken"`),
	})
	if !errors.Is(err, utilities.ErrInvalidJSON) {
		t.Fatalf("error = %v, want %v", err, utilities.ErrInvalidJSON)
	}
}

func TestRedactJSONSecretsRecursively(t *testing.T) {
	value := utilities.RedactJSONSecrets(json.RawMessage(`{
		"api_key":"secret",
		"region":"auto",
		"nested":{"privateKeyPem":"secret","public_key":"public"},
		"providers":[{"client_secret":"secret","name":"r2"}]
	}`))

	root, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("redacted value = %#v, want object", value)
	}
	if root["api_key"] != utilities.RedactedValue {
		t.Fatalf("api_key = %v, want redacted", root["api_key"])
	}
	if root["region"] != "auto" {
		t.Fatalf("region = %v, want auto", root["region"])
	}

	nested := root["nested"].(map[string]any)
	if nested["privateKeyPem"] != utilities.RedactedValue {
		t.Fatalf("privateKeyPem = %v, want redacted", nested["privateKeyPem"])
	}
	if nested["public_key"] != "public" {
		t.Fatalf("public_key = %v, want public", nested["public_key"])
	}

	providers := root["providers"].([]any)
	provider := providers[0].(map[string]any)
	if provider["client_secret"] != utilities.RedactedValue {
		t.Fatalf("client_secret = %v, want redacted", provider["client_secret"])
	}
	if provider["name"] != "r2" {
		t.Fatalf("name = %v, want r2", provider["name"])
	}
}

func TestRedactJSONSecretsHandlesUnreadableJSON(t *testing.T) {
	value := utilities.RedactJSONSecrets(json.RawMessage(`{"broken"`))
	status, ok := value.(map[string]string)
	if !ok {
		t.Fatalf("redacted value = %#v, want status object", value)
	}
	if status["status"] != "unreadable" {
		t.Fatalf("status = %q, want unreadable", status["status"])
	}
}
