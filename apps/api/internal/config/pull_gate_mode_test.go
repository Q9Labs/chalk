package config

import (
	"strings"
	"testing"
)

func TestPullGateModeConfig(t *testing.T) {
	for _, test := range []struct {
		name, value, want, wantError string
	}{
		{name: "default", want: PullGateModeHold},
		{name: "hold", value: "hold", want: PullGateModeHold},
		{name: "defer", value: "defer", want: PullGateModeDefer},
		{name: "normalized", value: " DEFER ", want: PullGateModeDefer},
		{name: "invalid", value: "skip", wantError: "CHALK_PULL_GATE_MODE must be one of: hold, defer"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(APIEnvironment, "local")
			t.Setenv(PullGateMode, test.value)
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
			if cfg.API.PullGateMode != test.want {
				t.Fatalf("PullGateMode = %q, want %q", cfg.API.PullGateMode, test.want)
			}
		})
	}
}
