package config

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func TestNewSpaceMediaPlane(t *testing.T) {
	everyone, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		value   string
		sfu     ChalkSFUConfig
		want    spaces.MediaPlaneProvider
		wantErr bool
	}{
		{"unset", "", ChalkSFUConfig{}, "", false},
		{"cloudflare needs no own SFU", "cf_sfu", ChalkSFUConfig{}, spaces.MediaPlaneProviderCloudflareSFU, false},
		{"own SFU while it is off", "chalk_sfu", ChalkSFUConfig{}, "", true},
		{"own SFU with an allowlist short of everyone", "chalk_sfu", ChalkSFUConfig{Enabled: true}, "", true},
		{"own SFU for everyone", "chalk_sfu", ChalkSFUConfig{Enabled: true, AllowedSpaces: everyone}, spaces.MediaPlaneProviderChalkSFU, false},
		{"unknown plane", "other", ChalkSFUConfig{}, "", true},
	}
	for _, c := range cases {
		t.Setenv(NewSpaceMediaPlane, c.value)
		got, err := loadNewSpaceMediaPlane(c.sfu)
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("%s: got %q, %v; want %q, error %v", c.name, got, err, c.want, c.wantErr)
		}
	}
}
