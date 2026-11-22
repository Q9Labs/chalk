package tenants

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestNormalizeMediaConfigFillsProviderAndMode(t *testing.T) {
	got, err := normalizeMediaConfig(json.RawMessage(`{"enabled":true}`))
	if err != nil {
		t.Fatalf("normalizeMediaConfig() error = %v", err)
	}
	want := `{"enabled":true,"provider":"` + mediaplane.ProviderChalkSFU.SettingName() + `","mode":"chalk_managed"}`
	if string(got) != want {
		t.Fatalf("normalizeMediaConfig() = %s, want %s", got, want)
	}
}

func TestNormalizeMediaConfigRejectsOtherProviders(t *testing.T) {
	for _, raw := range []string{`{"provider":"other"}`, `{"mode":"tenant_managed"}`, `[]`} {
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
