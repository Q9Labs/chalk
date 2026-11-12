package spaces

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func planePtr(p MediaPlaneProvider) *MediaPlaneProvider { return &p }

func stringPtr(s string) *string { return &s }

func allowAll(t *testing.T) ChalkSFUAllowlist {
	t.Helper()
	list, err := ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func TestEffectivePlanePrecedence(t *testing.T) {
	cf, own := MediaPlaneProviderCloudflareSFU, MediaPlaneProviderChalkSFU
	everyone := allowAll(t)
	cases := []struct {
		name     string
		policy   PlanePolicy
		tenant   *string
		approved bool
		setting  *MediaPlaneProvider
		stored   string
		want     MediaPlaneProvider
		wantFail bool
	}{
		{"nothing set follows the platform default", PlanePolicy{Platform: cf, Allowed: everyone}, nil, false, nil, "cf_sfu", cf, false},
		{"tenant beats platform", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("chalk_sfu"), true, nil, "cf_sfu", own, false},
		{"space beats tenant", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("chalk_sfu"), true, planePtr(cf), "cf_sfu", cf, false},
		{"space chalk_sfu beats tenant cf_sfu", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("cf_sfu"), false, planePtr(own), "cf_sfu", own, false},
		{"kill switch beats space", PlanePolicy{Platform: cf, Allowed: everyone, NewEpisodesPaused: true}, nil, false, planePtr(own), "chalk_sfu", cf, false},
		{"kill switch beats tenant", PlanePolicy{Platform: cf, Allowed: everyone, NewEpisodesPaused: true}, stringPtr("chalk_sfu"), true, nil, "cf_sfu", cf, false},
		{"allowlist stays an AND for a space", PlanePolicy{Platform: cf}, nil, false, planePtr(own), "chalk_sfu", cf, false},
		{"allowlist stays an AND for a tenant", PlanePolicy{Platform: cf}, stringPtr("chalk_sfu"), true, nil, "cf_sfu", cf, false},
		{"stored chalk_sfu without a setting is the space's own choice", PlanePolicy{Platform: cf, Allowed: everyone}, nil, false, nil, "chalk_sfu", own, false},
		{"stored chalk_sfu behind the kill switch", PlanePolicy{Platform: cf, Allowed: everyone, NewEpisodesPaused: true}, nil, false, nil, "chalk_sfu", cf, false},
		{"stored chalk_sfu outside the allowlist", PlanePolicy{Platform: cf}, nil, false, nil, "chalk_sfu", cf, false},
		{"stored value is the last fallback", PlanePolicy{Allowed: everyone}, nil, false, nil, "cf_sfu", cf, false},
		{"unknown tenant value falls back to the platform default", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("bogus"), false, nil, "cf_sfu", cf, false},
		{"legacy tenant chalk_sfu that no operator approved is ignored", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("chalk_sfu"), false, nil, "cf_sfu", cf, false},
		{"legacy tenant cf_sfu still counts", PlanePolicy{Platform: own, Allowed: everyone}, stringPtr("cf_sfu"), false, nil, "cf_sfu", cf, false},
	}
	for _, c := range cases {
		space := Space{MediaPlane: c.stored, MediaPlaneSetting: c.setting}
		got, err := c.policy.Effective(tenants.Tenant{DefaultMediaPlane: c.tenant, DefaultMediaPlaneApproved: c.approved}, space)
		if (err != nil) != c.wantFail {
			t.Errorf("%s: error = %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// A Tenant on its own Cloudflare credentials cannot reach the own SFU, so whatever chose the
// own SFU earlier, its next Episode starts on Cloudflare.
func TestATenantOnItsOwnCredentialsNeverSelectsTheOwnSFU(t *testing.T) {
	cf, own := MediaPlaneProviderCloudflareSFU, MediaPlaneProviderChalkSFU
	policy := PlanePolicy{Platform: cf, Allowed: allowAll(t)}
	ownText := string(own)
	tenant := tenants.Tenant{
		DefaultMediaPlane: &ownText, DefaultMediaPlaneApproved: true,
		MediaPlaneProviderConfig: []byte(`{"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"sfu":{"app_id":"a","app_secret":"b"}}}`),
	}
	for name, space := range map[string]Space{
		"tenant default": {MediaPlane: "cf_sfu"},
		"space setting":  {MediaPlane: "chalk_sfu", MediaPlaneSetting: planePtr(own)},
		"stored choice":  {MediaPlane: "chalk_sfu"},
	} {
		if got, err := policy.Effective(tenant, space); err != nil || got != cf {
			t.Errorf("%s: got %q, %v, want Cloudflare", name, got, err)
		}
	}
}

func TestPublicWritePlaneIsThePlatformDefault(t *testing.T) {
	if got := (PlanePolicy{}).PublicWritePlane(); got != MediaPlaneProviderCloudflareSFU {
		t.Errorf("no platform default: got %q", got)
	}
	if got := (PlanePolicy{Platform: MediaPlaneProviderChalkSFU}).PublicWritePlane(); got != MediaPlaneProviderChalkSFU {
		t.Errorf("platform default after cutover: got %q", got)
	}
}

type updatingRepository struct {
	Repository
	updated UpdateSpaceInput
	calls   int
	space   Space
}

func (r *updatingRepository) UpdateSpace(_ context.Context, _, _ utilities.ID, input UpdateSpaceInput) (Space, error) {
	r.updated = input
	r.calls++
	return r.space, nil
}

func (r *updatingRepository) GetSpace(context.Context, utilities.ID, utilities.ID) (Space, error) {
	return r.space, nil
}

func ids(t *testing.T) (utilities.ID, utilities.ID) {
	t.Helper()
	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	spaceID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return tenantID, spaceID
}

func TestPublicUpdateCannotSelectTheOwnSFU(t *testing.T) {
	tenantID, spaceID := ids(t)
	repository := &updatingRepository{}
	service := NewServiceWithDefaultProvider(repository, MediaPlaneProviderCloudflareSFU).WithPlanePolicy(PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU, Allowed: allowAll(t)})

	_, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true, Value: stringPtr("chalk_sfu")}})
	if !errors.Is(err, ErrMediaPlaneNotPermitted) {
		t.Fatalf("chalk_sfu from a public write: got %v, want ErrMediaPlaneNotPermitted", err)
	}
	if repository.calls != 0 {
		t.Fatal("a refused write reached the repository")
	}

	if _, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true, Value: stringPtr("cf_sfu")}}); err != nil {
		t.Fatalf("the platform default is allowed: %v", err)
	}
	if got := repository.updated.MediaPlaneSetting; !got.Set || got.Value == nil || *got.Value != MediaPlaneProviderCloudflareSFU {
		t.Errorf("setting after naming the default = %+v", got)
	}

	if _, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true}}); err != nil {
		t.Fatalf("null clears the setting: %v", err)
	}
	if got := repository.updated; !got.MediaPlaneSetting.Set || got.MediaPlaneSetting.Value != nil || got.MediaPlane.Value == nil || *got.MediaPlane.Value != "cf_sfu" {
		t.Errorf("clearing must null the setting and dual-write the platform default, got %+v / %+v", got.MediaPlaneSetting, got.MediaPlane)
	}

	if _, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true, Value: stringPtr("nonsense")}}); !errors.Is(err, ErrInvalidMediaPlane) {
		t.Errorf("an unknown plane: got %v, want ErrInvalidMediaPlane", err)
	}
}

func TestClearingASpacePlaneWorksWithoutAPlatformDefault(t *testing.T) {
	tenantID, spaceID := ids(t)
	repository := &updatingRepository{}
	service := Service{repository: repository}.WithPlanePolicy(PlanePolicy{Allowed: allowAll(t)})

	if _, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true}}); err != nil {
		t.Fatalf("clearing with CHALK_DEFAULT_MEDIA_PLANE unset: %v", err)
	}
	got := repository.updated
	if !got.MediaPlaneSetting.Set || got.MediaPlaneSetting.Value != nil || got.MediaPlane.Value == nil || *got.MediaPlane.Value != "cf_sfu" {
		t.Errorf("clearing must null the setting and store Cloudflare in the legacy column, got %+v / %+v", got.MediaPlaneSetting, got.MediaPlane)
	}
}

func TestPublicWriteNeverNamesTheOwnSFUWhateverNewSpacesGet(t *testing.T) {
	tenantID, spaceID := ids(t)
	repository := &updatingRepository{}
	policy := PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU, NewSpace: MediaPlaneProviderChalkSFU, Allowed: allowAll(t)}
	service := NewServiceWithDefaultProvider(repository, MediaPlaneProviderCloudflareSFU).WithPlanePolicy(policy).WithNewSpaceDefaults(NewSpaceDefaults{MediaPlane: MediaPlaneProviderChalkSFU}, fixedTenant{})

	if _, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true, Value: stringPtr("chalk_sfu")}}); !errors.Is(err, ErrMediaPlaneNotPermitted) {
		t.Fatalf("update naming the new-Space plane: got %v, want ErrMediaPlaneNotPermitted", err)
	}
	if repository.calls != 0 {
		t.Fatal("a refused update reached the repository")
	}
	_, err := create(t, service, func(input *CreateSpaceInput) {
		input.MediaPlane, input.MediaPlaneSet = "chalk_sfu", true
	})
	if !errors.Is(err, ErrMediaPlaneNotPermitted) {
		t.Fatalf("create naming the new-Space plane: got %v, want ErrMediaPlaneNotPermitted", err)
	}

	// Naming the platform default stays allowed, and omitting the plane still takes the
	// deployment's new-Space plane for a Tenant that can serve it.
	if _, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true, Value: stringPtr("cf_sfu")}}); err != nil {
		t.Fatalf("the platform default: %v", err)
	}
	got, err := create(t, service, func(*CreateSpaceInput) {})
	if err != nil || got.MediaPlaneSetting == nil || *got.MediaPlaneSetting != MediaPlaneProviderChalkSFU {
		t.Fatalf("a deployment default for a Space that names none: %+v, %v", got.MediaPlaneSetting, err)
	}
}

func TestPublicWritePlaneStaysThePlatformDefault(t *testing.T) {
	policy := PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU, NewSpace: MediaPlaneProviderChalkSFU}
	if got := policy.PublicWritePlane(); got != MediaPlaneProviderCloudflareSFU {
		t.Errorf("the write plane widened to %q", got)
	}
}

func TestEffectivePlaneOfATenantWithMediaDisabledIsNone(t *testing.T) {
	policy := PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU, Allowed: allowAll(t)}
	for name, config := range map[string]string{"disabled": `{"enabled":false,"mode":"chalk_managed"}`} {
		tenant := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(config)}
		got, err := policy.Effective(tenant, Space{MediaPlane: "cf_sfu"})
		if err != nil || got != "" {
			t.Errorf("%s Tenant: effective = %q, %v, want no plane", name, got, err)
		}
	}
}

func TestOperatorCanReplaceALegacyTenantDefaultItCannotParse(t *testing.T) {
	tenantID, _ := ids(t)
	for _, plane := range []*MediaPlaneProvider{nil, planePtr(MediaPlaneProviderCloudflareSFU)} {
		store := &recordingTenantStore{tenant: tenants.Tenant{DefaultMediaPlane: stringPtr("bogus")}}
		change, err := NewPlaneOperator(&updatingRepository{}, store, PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU}).SetTenant(context.Background(), tenantID, plane)
		if err != nil {
			t.Fatalf("replacing a legacy value with %v: %v", plane, err)
		}
		if !store.written {
			t.Errorf("replacing with %v never reached the store", plane)
		}
		if change.Before == nil || *change.Before != "bogus" {
			t.Errorf("the audit line lost the raw legacy value: %v", change.Before)
		}
	}
}

type recordingTenantStore struct {
	tenant  tenants.Tenant
	written bool
}

func (s *recordingTenantStore) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return s.tenant, nil
}

func (s *recordingTenantStore) SetDefaultMediaPlane(context.Context, utilities.ID, *string) (tenants.Tenant, error) {
	s.written = true
	return s.tenant, nil
}

func TestPublicCreateCannotSelectTheOwnSFUUnlessConfigDriven(t *testing.T) {
	service := NewServiceWithDefaultProvider(nil, MediaPlaneProviderCloudflareSFU).WithPlanePolicy(PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU, Allowed: allowAll(t)})
	_, err := create(t, service, func(input *CreateSpaceInput) {
		input.MediaPlane, input.MediaPlaneSet = "chalk_sfu", true
	})
	if !errors.Is(err, ErrMediaPlaneNotPermitted) {
		t.Fatalf("got %v, want ErrMediaPlaneNotPermitted", err)
	}
	got, err := create(t, service, func(input *CreateSpaceInput) {
		input.MediaPlane, input.MediaPlaneSet, input.MediaPlaneFromConfig = "chalk_sfu", true, true
	})
	if err != nil {
		t.Fatalf("a plane that deployment config chose: %v", err)
	}
	if got.MediaPlaneSetting == nil || *got.MediaPlaneSetting != MediaPlaneProviderChalkSFU {
		t.Errorf("setting = %v", got.MediaPlaneSetting)
	}
}

func TestOperatorSetsAndClearsASpace(t *testing.T) {
	tenantID, spaceID := ids(t)
	repository := &updatingRepository{space: Space{MediaPlaneSetting: planePtr(MediaPlaneProviderCloudflareSFU)}}
	operator := NewPlaneOperator(repository, tenantStore{}, PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU})

	change, err := operator.SetSpace(context.Background(), tenantID, spaceID, planePtr(MediaPlaneProviderChalkSFU))
	if err != nil {
		t.Fatal(err)
	}
	if change.Before == nil || *change.Before != "cf_sfu" || *change.After != "chalk_sfu" {
		t.Errorf("change = %+v", change)
	}
	if got := repository.updated; *got.MediaPlane.Value != "chalk_sfu" || *got.MediaPlaneSetting.Value != MediaPlaneProviderChalkSFU {
		t.Errorf("update = %+v", got)
	}

	if _, err := operator.SetSpace(context.Background(), tenantID, spaceID, nil); err != nil {
		t.Fatal(err)
	}
	if got := repository.updated; got.MediaPlaneSetting.Value != nil || *got.MediaPlane.Value != "cf_sfu" {
		t.Errorf("cleared update = %+v, want a null setting and the platform default in media_plane", got)
	}
}

func TestOperatorRefusesTheOwnSFUForTenantsThatCannotServeIt(t *testing.T) {
	tenantID, spaceID := ids(t)
	for name, config := range map[string]string{
		"tenant managed": `{"provider":"cf_sfu","mode":"tenant_managed"}`,
		"disabled":       `{"enabled":false,"mode":"chalk_managed"}`,
	} {
		repository := &updatingRepository{}
		operator := NewPlaneOperator(repository, tenantStore{tenant: tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(config)}}, PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU})
		if _, err := operator.SetSpace(context.Background(), tenantID, spaceID, planePtr(MediaPlaneProviderChalkSFU)); !errors.Is(err, ErrTenantCannotServePlane) {
			t.Errorf("%s Space: got %v", name, err)
		}
		if _, err := operator.SetTenant(context.Background(), tenantID, planePtr(MediaPlaneProviderChalkSFU)); !errors.Is(err, ErrTenantCannotServePlane) {
			t.Errorf("%s Tenant: got %v", name, err)
		}
		if repository.calls != 0 {
			t.Errorf("%s: a refused write reached the repository", name)
		}
	}
}

type tenantStore struct {
	tenant tenants.Tenant
}

func (s tenantStore) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return s.tenant, nil
}

func (s tenantStore) SetDefaultMediaPlane(context.Context, utilities.ID, *string) (tenants.Tenant, error) {
	return s.tenant, nil
}

func TestLiveSwitchPausesOnTopOfTheDeployFloor(t *testing.T) {
	cf, own := MediaPlaneProviderCloudflareSFU, MediaPlaneProviderChalkSFU
	policy := PlanePolicy{Platform: own, Allowed: allowAll(t)}
	if got, _ := policy.Effective(tenants.Tenant{}, Space{}); got != own {
		t.Fatalf("an own SFU default with the switch on: got %q", got)
	}
	if got, _ := policy.Paused(true).Effective(tenants.Tenant{}, Space{}); got != cf {
		t.Fatalf("the live switch off must send new Episodes to Cloudflare: got %q", got)
	}
	floor := PlanePolicy{Platform: own, Allowed: allowAll(t), NewEpisodesPaused: true}
	if !floor.Paused(false).NewEpisodesPaused {
		t.Fatal("a live switch that is on must not lift the deploy-time floor")
	}
}

func TestPausedValueTravelsInTheContext(t *testing.T) {
	if _, carried := NewEpisodesPausedFrom(context.Background()); carried {
		t.Fatal("a plain context carries no switch value")
	}
	for _, want := range []bool{true, false} {
		got, carried := NewEpisodesPausedFrom(WithNewEpisodesPaused(context.Background(), want))
		if !carried || got != want {
			t.Fatalf("carried %v, got %v carried %v", want, got, carried)
		}
	}
}

func TestOwnSFUDefaultAllowsNamingBothPlanesAndStoresCloudflareForInheritingSpaces(t *testing.T) {
	cf, own := MediaPlaneProviderCloudflareSFU, MediaPlaneProviderChalkSFU
	policy := PlanePolicy{Platform: own, Allowed: allowAll(t)}
	if !policy.PublicWriteAllowed(own) || !policy.PublicWriteAllowed(cf) {
		t.Fatal("under an own SFU default an owner may name the default and Cloudflare")
	}
	cfDefault := PlanePolicy{Platform: cf}
	if cfDefault.PublicWriteAllowed(own) {
		t.Fatal("under a Cloudflare default an owner must not name the own SFU")
	}
	if got := policy.legacyPlane(nil); got != string(cf) {
		t.Fatalf("an inheriting Space must store cf_sfu, got %q", got)
	}
	if got := policy.legacyPlane(planePtr(own)); got != string(own) {
		t.Fatalf("a Space's own choice is stored as is, got %q", got)
	}
}

func TestPublicWriteNamingTheOwnSFUDefaultFollowsTheDefaultBackToCloudflare(t *testing.T) {
	cf, own := MediaPlaneProviderCloudflareSFU, MediaPlaneProviderChalkSFU
	ownDefault := PlanePolicy{Platform: own, Allowed: allowAll(t)}
	reverted := PlanePolicy{Platform: cf, Allowed: allowAll(t)}
	service := NewServiceWithDefaultProvider(nil, own).WithPlanePolicy(ownDefault)

	created, err := create(t, service, func(input *CreateSpaceInput) { input.MediaPlane, input.MediaPlaneSet = "chalk_sfu", true })
	if err != nil {
		t.Fatal(err)
	}
	repository := &updatingRepository{}
	service.repository = repository
	tenantID, spaceID := ids(t)
	if _, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true, Value: stringPtr("chalk_sfu")}}); err != nil {
		t.Fatal(err)
	}

	for name, space := range map[string]Space{
		"create": {MediaPlaneSetting: created.MediaPlaneSetting, MediaPlane: created.MediaPlane},
		"update": {MediaPlaneSetting: repository.updated.MediaPlaneSetting.Value, MediaPlane: *repository.updated.MediaPlane.Value},
	} {
		if got, err := ownDefault.Effective(tenants.Tenant{}, space); err != nil || got != own {
			t.Fatalf("%s: under the own SFU default the next Episode resolves to %q, %v; want chalk_sfu", name, got, err)
		}
		if got, err := reverted.Effective(tenants.Tenant{}, space); err != nil || got != cf {
			t.Errorf("%s: after the default moved back the next Episode resolves to %q, %v; want cf_sfu", name, got, err)
		}
	}
}
