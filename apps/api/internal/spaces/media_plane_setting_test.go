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
		setting  *MediaPlaneProvider
		stored   string
		want     MediaPlaneProvider
		wantFail bool
	}{
		{"nothing set follows the platform default", PlanePolicy{Platform: cf, Allowed: everyone}, nil, nil, "cf_sfu", cf, false},
		{"tenant beats platform", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("chalk_sfu"), nil, "cf_sfu", own, false},
		{"space beats tenant", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("chalk_sfu"), planePtr(cf), "cf_sfu", cf, false},
		{"space chalk_sfu beats tenant cf_sfu", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("cf_sfu"), planePtr(own), "cf_sfu", own, false},
		{"kill switch beats space", PlanePolicy{Platform: cf, Allowed: everyone, NewEpisodesPaused: true}, nil, planePtr(own), "chalk_sfu", cf, false},
		{"kill switch beats tenant", PlanePolicy{Platform: cf, Allowed: everyone, NewEpisodesPaused: true}, stringPtr("chalk_sfu"), nil, "cf_sfu", cf, false},
		{"allowlist stays an AND for a space", PlanePolicy{Platform: cf}, nil, planePtr(own), "chalk_sfu", cf, false},
		{"allowlist stays an AND for a tenant", PlanePolicy{Platform: cf}, stringPtr("chalk_sfu"), nil, "cf_sfu", cf, false},
		{"stored chalk_sfu without a setting is the space's own choice", PlanePolicy{Platform: cf, Allowed: everyone}, nil, nil, "chalk_sfu", own, false},
		{"stored chalk_sfu behind the kill switch", PlanePolicy{Platform: cf, Allowed: everyone, NewEpisodesPaused: true}, nil, nil, "chalk_sfu", cf, false},
		{"stored chalk_sfu outside the allowlist", PlanePolicy{Platform: cf}, nil, nil, "chalk_sfu", cf, false},
		{"stored value is the last fallback", PlanePolicy{Allowed: everyone}, nil, nil, "cf_sfu", cf, false},
		{"unknown tenant value fails", PlanePolicy{Platform: cf, Allowed: everyone}, stringPtr("bogus"), nil, "cf_sfu", "", true},
	}
	for _, c := range cases {
		space := Space{MediaPlane: c.stored, MediaPlaneSetting: c.setting}
		got, err := c.policy.Effective(tenants.Tenant{DefaultMediaPlane: c.tenant}, space)
		if (err != nil) != c.wantFail {
			t.Errorf("%s: error = %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
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

func TestPublicWriteMayNameTheNewSpacePlane(t *testing.T) {
	tenantID, spaceID := ids(t)
	repository := &updatingRepository{}
	policy := PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU, NewSpace: MediaPlaneProviderChalkSFU, Allowed: allowAll(t)}
	service := NewServiceWithDefaultProvider(repository, MediaPlaneProviderCloudflareSFU).WithPlanePolicy(policy)
	if _, err := service.UpdateSpace(context.Background(), tenantID, spaceID, UpdateSpaceInput{MediaPlane: utilities.OptionalString{Set: true, Value: stringPtr("chalk_sfu")}}); err != nil {
		t.Fatalf("a deployment whose new Spaces already get the own SFU: %v", err)
	}
	if got := policy.PublicWritePlane(); got != MediaPlaneProviderCloudflareSFU {
		t.Errorf("the Tenant-level write plane widened to %q", got)
	}
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
	if change.Before == nil || *change.Before != MediaPlaneProviderCloudflareSFU || *change.After != MediaPlaneProviderChalkSFU {
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
