package spaces

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func operatorContext() context.Context {
	return mediaplane.WithChangeOrigin(context.Background(), mediaplane.ChangeOrigin{Actor: "hasan", Reason: "test"})
}

// A change with no actor or no reason writes nothing: the trail would hold a row nobody can read.
func TestOperatorRefusesAChangeWithoutAnOrigin(t *testing.T) {
	tenantID, spaceID := ids(t)
	operator := NewPlaneOperator(&updatingRepository{}, tenantStore{}, PlanePolicy{Platform: mediaplane.ProviderCloudflareSFU})
	for name, ctx := range map[string]context.Context{
		"none":          context.Background(),
		"no reason":     mediaplane.WithChangeOrigin(context.Background(), mediaplane.ChangeOrigin{Actor: "hasan"}),
		"blank partner": mediaplane.WithChangeOrigin(context.Background(), mediaplane.ChangeOrigin{Actor: " ", Reason: "why"}),
	} {
		if _, err := operator.SetTenant(ctx, tenantID, planePtr(mediaplane.ProviderCloudflareSFU)); !errors.Is(err, mediaplane.ErrChangeOriginMissing) {
			t.Errorf("%s: SetTenant err = %v", name, err)
		}
		if _, err := operator.SetSpace(ctx, tenantID, spaceID, nil); !errors.Is(err, mediaplane.ErrChangeOriginMissing) {
			t.Errorf("%s: SetSpace err = %v", name, err)
		}
	}
}

func TestRefusalPutsTheKillSwitchBeforeTheAllowlist(t *testing.T) {
	_, space := ids(t)
	nobody, err := ParseChalkSFUAllowlist(nil)
	if err != nil {
		t.Fatal(err)
	}
	everyone := allowAll(t)
	for name, c := range map[string]struct {
		paused  bool
		allowed ChalkSFUAllowlist
		want    mediaplane.Selector
	}{
		"both":      {true, nobody, mediaplane.SelectedByKillSwitch},
		"switch":    {true, everyone, mediaplane.SelectedByKillSwitch},
		"allowlist": {false, nobody, mediaplane.SelectedByAllowlist},
		"neither":   {false, everyone, ""},
	} {
		if got := Refusal(c.paused, c.allowed, space); got != c.want {
			t.Errorf("%s: Refusal = %q, want %q", name, got, c.want)
		}
	}
}

func TestSelectPlaneSaysWhichRuleChose(t *testing.T) {
	cf, own := mediaplane.ProviderCloudflareSFU, mediaplane.ProviderChalkSFU
	ownCredentials := json.RawMessage(`{"provider":"cf_sfu","mode":"tenant_managed"}`)
	for name, c := range map[string]struct {
		platform mediaplane.Provider
		tenant   tenants.Tenant
		space    Space
		want     PlaneChoice
	}{
		"space setting":         {cf, tenants.Tenant{}, Space{MediaPlaneSetting: planePtr(cf)}, PlaneChoice{cf, mediaplane.SelectedBySpace}},
		"stored chalk_sfu":      {cf, tenants.Tenant{}, Space{MediaPlane: mediaplane.PlaneChalk}, PlaneChoice{own, mediaplane.SelectedBySpace}},
		"tenant default":        {cf, tenants.Tenant{DefaultMediaPlane: stringPtr(mediaplane.PlaneChalk), DefaultMediaPlaneApproved: true}, Space{}, PlaneChoice{own, mediaplane.SelectedByTenant}},
		"platform default":      {cf, tenants.Tenant{}, Space{}, PlaneChoice{cf, mediaplane.SelectedByDefault}},
		"tenant own cloudflare": {cf, tenants.Tenant{MediaPlaneProviderConfig: ownCredentials}, Space{MediaPlaneSetting: planePtr(own)}, PlaneChoice{cf, mediaplane.SelectedByTenantConfig}},
	} {
		got, err := SelectPlane(c.platform, c.tenant, c.space)
		if err != nil || got != c.want {
			t.Errorf("%s: got %+v, %v, want %+v", name, got, err, c.want)
		}
	}
}
