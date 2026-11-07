package postgres

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func TestRequireClientRunsBinding(t *testing.T) {
	own, err := mediaplane.NewBinding(string(spaces.MediaPlaneProviderChalkSFU), mediaplane.BindingSourceDeploymentDefault, "app")
	if err != nil {
		t.Fatal(err)
	}
	cloudflare, err := mediaplane.NewBinding(string(spaces.MediaPlaneProviderCloudflareSFU), mediaplane.BindingSourceDeploymentDefault, "app")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func(binding *mediaplane.Binding) []byte {
		encoded, err := json.Marshal(map[string]any{"media_plane_binding": binding})
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	tests := []struct {
		name     string
		snapshot []byte
		clients  mediaplane.ClientProviders
		want     error
	}{
		{"own SFU Episode, declaring client", snapshot(&own), mediaplane.ParseClientProviders("chalk_sfu"), nil},
		{"own SFU Episode, silent client", snapshot(&own), mediaplane.ClientProviders{}, mediaplane.ErrClientUnsupported},
		{"Cloudflare Episode, silent client", snapshot(&cloudflare), mediaplane.ClientProviders{}, nil},
		{"Cloudflare Episode, declaring client", snapshot(&cloudflare), mediaplane.ParseClientProviders("cloudflare_sfu,chalk_sfu"), nil},
		{"Episode without media", snapshot(nil), mediaplane.ClientProviders{}, nil},
		{"Episode from before bindings", []byte(`{}`), mediaplane.ClientProviders{}, nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := requireClientRunsBinding(episodes.Episode{ConfigSnapshot: test.snapshot}, test.clients)
			if !errors.Is(err, test.want) || (test.want == nil && err != nil) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}
