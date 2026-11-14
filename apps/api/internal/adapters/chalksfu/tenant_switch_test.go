package chalksfu_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// A live Episode keeps the binding it started with. Its Tenant may later switch to its own
// Cloudflare credentials, which cannot serve the Chalk SFU; that changes where the next Episode
// starts, never where this one runs.
func TestALiveChalkSFUEpisodeSurvivesItsTenantSwitchingToOwnCredentials(t *testing.T) {
	ca, primary, _, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	registry := recoveryRegistry(fleet, newRecoveryStore(bound, 2))
	ownChoice := mediaplane.ProviderChalkSFU.SettingName()
	switched := tenants.Tenant{
		ID:                        recoveringTenant.ID,
		DefaultMediaPlane:         &ownChoice,
		DefaultMediaPlaneApproved: true,
		MediaPlaneProviderConfig:  json.RawMessage(`{"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"sfu":{"app_id":"tenant-app","app_secret":"test-secret"}}}`),
	}

	service, err := registry.ResolveEpisode(context.Background(), switched, chalkSpace, recoveringEpisode)
	if err != nil || service == nil {
		t.Fatalf("the live Episode must keep resolving from its binding: %v", err)
	}

	next, err := recoveryRegistry(fleet, newRecoveryStore(mediaplane.Binding{}, 0)).ResolveBinding(context.Background(), switched, spaces.Space{MediaPlane: "cf_sfu"}, chalkSFUClients)
	if err != nil || next == nil || next.Provider != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Fatalf("the next Episode of a Tenant on its own credentials must start on Cloudflare: %+v, %v", next, err)
	}
}
