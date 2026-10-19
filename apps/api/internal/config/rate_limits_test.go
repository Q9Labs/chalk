package config

import (
	"strings"
	"testing"
)

func TestRateLimitsConfig(t *testing.T) {
	for _, test := range []struct {
		name, environment, value, wantError string
		disabled                            bool
	}{
		{name: "default", environment: "local"},
		{name: "enabled", environment: "local", value: "on"},
		{name: "disabled", environment: "local", value: "off", disabled: true},
		{name: "normalized", environment: "local", value: " OFF ", disabled: true},
		{name: "invalid", environment: "local", value: "false", wantError: "CHALK_API_RATE_LIMITS must be one of: on, off"},
		{name: "production", environment: "production", value: "off", wantError: "CHALK_API_RATE_LIMITS=off is only allowed when CHALK_API_ENV=local"},
		{name: "nightly", environment: "nightly", value: "off", wantError: "CHALK_API_RATE_LIMITS=off is only allowed when CHALK_API_ENV=local"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(APIEnvironment, test.environment)
			t.Setenv(APIRateLimits, test.value)
			cfg, err := Load()
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("Load() error = %v, want %q", err, test.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.API.DisableAuthenticatedRateLimits != test.disabled {
				t.Fatalf("disabled = %v, want %v", cfg.API.DisableAuthenticatedRateLimits, test.disabled)
			}
		})
	}
}
