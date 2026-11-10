package config

import (
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func TestLoadPlanePolicyReadsTheKillSwitch(t *testing.T) {
	cases := []struct {
		value      string
		wantPaused bool
		wantErr    string
	}{
		{"", false, ""},
		{"on", false, ""},
		{" ON ", false, ""},
		{"true", false, ""},
		{"off", true, ""},
		{"false", true, ""},
		{"paused", false, "CHALK_SFU_NEW_EPISODES must be on or off"},
	}
	for _, c := range cases {
		t.Setenv(ChalkSFUNewEpisodes, c.value)
		t.Setenv(DefaultMediaPlane, "cf_sfu")
		t.Setenv(ChalkSFUAllowedSpaces, "*")
		policy, err := LoadPlanePolicy()
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%q: err = %v, want %q", c.value, err, c.wantErr)
			}
			continue
		}
		if err != nil || policy.NewEpisodesPaused != c.wantPaused || policy.Platform != spaces.MediaPlaneProviderCloudflareSFU {
			t.Errorf("%q: policy = %+v, err = %v", c.value, policy, err)
		}
	}
}
