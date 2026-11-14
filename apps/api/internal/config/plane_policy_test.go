package config

import (
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
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
		if err != nil || policy.NewEpisodesPaused != c.wantPaused || policy.Platform != mediaplane.ProviderCloudflareSFU {
			t.Errorf("%q: policy = %+v, err = %v", c.value, policy, err)
		}
	}
}

func TestChalkSFUPlatformDefaultNeedsTheSFUAndKeepsCloudflare(t *testing.T) {
	cloudflare := CloudflareRealtimeConfig{RealtimeAppID: "app", RealtimeAppSecret: "secret", RequestTimeout: 1}
	cases := []struct {
		name       string
		provider   mediaplane.Provider
		cloudflare CloudflareRealtimeConfig
		sfu        ChalkSFUConfig
		wantErr    string
	}{
		{"own SFU default runs with Cloudflare as fallback", mediaplane.ProviderChalkSFU, cloudflare, ChalkSFUConfig{Enabled: true, CaptureEnabled: true}, ""},
		{"own SFU default needs capture for recording", mediaplane.ProviderChalkSFU, cloudflare, ChalkSFUConfig{Enabled: true}, ChalkSFUCaptureEnabled},
		{"own SFU default needs the SFU enabled", mediaplane.ProviderChalkSFU, cloudflare, ChalkSFUConfig{}, ChalkSFUEnabled},
		{"own SFU default needs the Cloudflare fallback", mediaplane.ProviderChalkSFU, CloudflareRealtimeConfig{RequestTimeout: 1}, ChalkSFUConfig{Enabled: true, CaptureEnabled: true}, CloudflareRealtimeAppID},
		{"Cloudflare default keeps working", mediaplane.ProviderCloudflareSFU, cloudflare, ChalkSFUConfig{}, ""},
		{"no default needs nothing", "", CloudflareRealtimeConfig{}, ChalkSFUConfig{}, ""},
	}
	for _, c := range cases {
		err := validateMediaPlaneProcessConfig(c.provider, c.cloudflare, c.sfu)
		if c.wantErr == "" && err != nil || c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.wantErr)
		}
	}
}
