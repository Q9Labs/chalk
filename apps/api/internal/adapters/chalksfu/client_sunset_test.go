package chalksfu_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// After the client sunset an allowlisted Space refuses a client that cannot run
// the own SFU, instead of giving it Cloudflare. Before it, and for a Space off
// the allowlist, nothing changes.
func TestConformanceClientSunsetRefusesAnOldClientInAnAllowedSpace(t *testing.T) {
	fleet := startSFU(t, nil).fleet(t)
	sunset := time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)
	chalkSpace := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}

	otherSpace, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	onlyOther, err := spaces.ParseChalkSFUAllowlist([]string{otherSpace.String()})
	if err != nil {
		t.Fatal(err)
	}
	oldClient := mediaplane.ParseClientProviders("")

	tests := []struct {
		name      string
		allowed   spaces.ChalkSFUAllowlist
		sunset    time.Time
		now       time.Time
		clients   mediaplane.ClientProviders
		want      spaces.MediaPlaneProvider
		wantError error
	}{
		{"old client before the sunset gets Cloudflare", everySpace, sunset, sunset.Add(-time.Second), oldClient, spaces.MediaPlaneProviderCloudflareSFU, nil},
		{"old client at the sunset is refused", everySpace, sunset, sunset, oldClient, "", mediaplane.ErrClientUnsupported},
		{"old client after the sunset is refused", everySpace, sunset, sunset.Add(time.Hour), oldClient, "", mediaplane.ErrClientUnsupported},
		{"no sunset set never refuses", everySpace, time.Time{}, sunset.Add(time.Hour), oldClient, spaces.MediaPlaneProviderCloudflareSFU, nil},
		{"declaring client after the sunset gets the own SFU", everySpace, sunset, sunset.Add(time.Hour), ownSFUClients, spaces.MediaPlaneProviderChalkSFU, nil},
		{"old client in a Space off the allowlist keeps Cloudflare after the sunset", onlyOther, sunset, sunset.Add(time.Hour), oldClient, spaces.MediaPlaneProviderCloudflareSFU, nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
				ProcessConfig: withCloudflare, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU,
				ChalkSFU: fleet, ChalkSFUSpaces: test.allowed, ChalkSFUClientSunset: test.sunset,
				Now: func() time.Time { return test.now },
			})
			binding, err := registry.ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, test.clients)
			if !errors.Is(err, test.wantError) {
				t.Fatalf("error %v, want %v", err, test.wantError)
			}
			if test.wantError != nil {
				if binding != nil {
					t.Fatalf("binding %+v with an error, want none", binding)
				}
				return
			}
			if binding == nil || binding.Provider != string(test.want) {
				t.Fatalf("binding %+v, want provider %s", binding, test.want)
			}
		})
	}
}
