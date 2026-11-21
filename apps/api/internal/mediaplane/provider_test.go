package mediaplane_test

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestRetiredProvidersAreReadOnly(t *testing.T) {
	for _, provider := range []string{"cf_sfu", "cf_rtk"} {
		t.Run(provider, func(t *testing.T) {
			if _, err := mediaplane.ParseSettingName(provider); !errors.Is(err, mediaplane.ErrInvalidProvider) {
				t.Fatalf("current settings accepted retired provider %q: %v", provider, err)
			}
			binding, err := mediaplane.NewBinding(mediaplane.ProviderChalkSFU, mediaplane.BindingSourceDeploymentDefault, "fixture")
			if err != nil {
				t.Fatal(err)
			}
			binding.Provider = provider
			if err := binding.Validate(); err != nil {
				t.Fatalf("old Episode binding unreadable: %v", err)
			}
			if _, err := binding.ProviderID(); !errors.Is(err, mediaplane.ErrInvalidBinding) {
				t.Fatalf("old Episode binding resolves to a running provider: %v", err)
			}
		})
	}
}
