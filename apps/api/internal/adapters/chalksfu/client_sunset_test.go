package chalksfu_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// After the client sunset an allowlisted Space refuses a client that cannot run
// the Chalk SFU, instead of giving it Cloudflare. Before it, and for a Space off
// the allowlist, nothing changes.
func TestConformanceClientSunsetRefusesAnOldClientInAnAllowedSpace(t *testing.T) {
	fleet := startSFU(t, nil).fleet(t)
	fleet.Probe(context.Background())
	sunset := time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}

	otherSpace, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	onlyOther, err := spaces.ParseChalkSFUAllowlist([]string{otherSpace.String()})
	if err != nil {
		t.Fatal(err)
	}
	oldClient := mediaplane.ParseClientProviders("")
	disabledMedia := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"enabled":false}`)}

	tests := []struct {
		name      string
		tenant    tenants.Tenant
		allowed   spaces.ChalkSFUAllowlist
		sunset    time.Time
		now       time.Time
		clients   mediaplane.ClientProviders
		want      mediaplane.Provider
		wantError error
	}{
		{"old client before the sunset gets Cloudflare", tenants.Tenant{}, everySpace, sunset, sunset.Add(-time.Second), oldClient, mediaplane.ProviderCloudflareSFU, nil},
		{"old client at the sunset is refused", tenants.Tenant{}, everySpace, sunset, sunset, oldClient, "", mediaplane.ErrClientUnsupported},
		{"old client after the sunset is refused", tenants.Tenant{}, everySpace, sunset, sunset.Add(time.Hour), oldClient, "", mediaplane.ErrClientUnsupported},
		{"no sunset set never refuses", tenants.Tenant{}, everySpace, time.Time{}, sunset.Add(time.Hour), oldClient, mediaplane.ProviderCloudflareSFU, nil},
		{"declaring client after the sunset gets the Chalk SFU", tenants.Tenant{}, everySpace, sunset, sunset.Add(time.Hour), chalkSFUClients, mediaplane.ProviderChalkSFU, nil},
		{"old client with tenant media disabled still starts a media-free Episode", disabledMedia, everySpace, sunset, sunset.Add(time.Hour), oldClient, "", nil},
		{"old client in a Space off the allowlist keeps Cloudflare after the sunset", tenants.Tenant{}, onlyOther, sunset, sunset.Add(time.Hour), oldClient, mediaplane.ProviderCloudflareSFU, nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
				ProcessConfig: withCloudflare, DefaultProvider: mediaplane.ProviderCloudflareSFU,
				ChalkSFU: fleet, Rollout: mediaplaneproviders.Rollout{Spaces: test.allowed, ClientSunset: test.sunset, Now: func() time.Time { return test.now }},
			})
			binding, err := registry.ResolveBinding(context.Background(), test.tenant, chalkSpace, test.clients)
			if !errors.Is(err, test.wantError) {
				t.Fatalf("error %v, want %v", err, test.wantError)
			}
			if test.wantError != nil {
				if binding != nil {
					t.Fatalf("binding %+v with an error, want none", binding)
				}
				return
			}
			if test.want == "" {
				if binding != nil {
					t.Fatalf("binding %+v, want none for disabled media", binding)
				}
				return
			}
			if binding == nil || binding.Provider != test.want.SettingName() {
				t.Fatalf("binding %+v, want provider %s", binding, test.want)
			}
		})
	}
}

// A public call asks before it creates a Space, and that Space has no ID yet, so
// only the allowlist entry * covers it.
func TestConformanceRefuseClientBeforeASpaceExists(t *testing.T) {
	fleet := startSFU(t, nil).fleet(t)
	fleet.Probe(context.Background())
	sunset := time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)
	newSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	otherSpace, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	onlyOther, err := spaces.ParseChalkSFUAllowlist([]string{otherSpace.String()})
	if err != nil {
		t.Fatal(err)
	}
	for name, test := range map[string]struct {
		allowed spaces.ChalkSFUAllowlist
		clients mediaplane.ClientProviders
		want    error
	}{
		"old client, every Space allowed":          {everySpace, mediaplane.ParseClientProviders(""), mediaplane.ErrClientUnsupported},
		"declaring client, every Space allowed":    {everySpace, chalkSFUClients, nil},
		"old client, a new Space is not on a list": {onlyOther, mediaplane.ParseClientProviders(""), nil},
	} {
		t.Run(name, func(t *testing.T) {
			registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
				ProcessConfig: withCloudflare, DefaultProvider: mediaplane.ProviderCloudflareSFU,
				ChalkSFU: fleet, Rollout: mediaplaneproviders.Rollout{Spaces: test.allowed, ClientSunset: sunset, Now: func() time.Time { return sunset }},
			})
			if err := registry.RefuseClient(context.Background(), tenants.Tenant{}, newSpace, test.clients); !errors.Is(err, test.want) {
				t.Fatalf("error %v, want %v", err, test.want)
			}
		})
	}
}

// A refusal is a 409 and the request log keeps only its status, so the refusal
// logs its own bounded reason.
func TestConformanceClientSunsetRefusalLogsItsReason(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	sunset := time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)
	registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig: withCloudflare, DefaultProvider: mediaplane.ProviderCloudflareSFU,
		ChalkSFU: startSFU(t, nil).fleet(t), Rollout: mediaplaneproviders.Rollout{Spaces: everySpace, ClientSunset: sunset, Now: func() time.Time { return sunset }},
	})
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	if err := registry.RefuseClient(context.Background(), tenants.Tenant{}, chalkSpace, mediaplane.ParseClientProviders("")); !errors.Is(err, mediaplane.ErrClientUnsupported) {
		t.Fatalf("error %v, want a refusal", err)
	}
	if !strings.Contains(logs.String(), "event=chalk_sfu.client_refused") || !strings.Contains(logs.String(), "reason=client_sunset") {
		t.Fatalf("refusal log = %q, want the event and the client_sunset reason", logs.String())
	}
}
