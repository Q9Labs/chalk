package tenants

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestNormalizeMediaConfigFillsProviderAndMode(t *testing.T) {
	got, err := normalizeMediaConfig(json.RawMessage(`{"enabled":true}`))
	if err != nil {
		t.Fatalf("normalizeMediaConfig() error = %v", err)
	}
	if want := `{"enabled":true,"provider":"chalk_sfu","mode":"chalk_managed"}`; string(got) != want {
		t.Fatalf("normalizeMediaConfig() = %s, want %s", got, want)
	}
}

func TestNormalizeMediaConfigRejectsOtherProviders(t *testing.T) {
	for _, raw := range []string{`{"provider":"cf_sfu"}`, `{"mode":"tenant_managed"}`, `[]`} {
		if _, err := normalizeMediaConfig(json.RawMessage(raw)); !errors.Is(err, ErrInvalidTenantField) {
			t.Fatalf("normalizeMediaConfig(%s) error = %v, want ErrInvalidTenantField", raw, err)
		}
	}
}

func TestNormalizeMediaConfigLeavesMissingDocument(t *testing.T) {
	for _, raw := range []string{``, `null`} {
		got, err := normalizeMediaConfig(json.RawMessage(raw))
		if err != nil || string(got) != raw {
			t.Fatalf("normalizeMediaConfig(%q) = %q, %v", raw, got, err)
		}
	}
}
