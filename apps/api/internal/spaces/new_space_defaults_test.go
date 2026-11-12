package spaces

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type capturingRepository struct {
	Repository
	created CreateSpaceInput
}

func (r *capturingRepository) CreateSpace(_ context.Context, input CreateSpaceInput) (Space, error) {
	r.created = input
	return Space{}, nil
}

type fixedTenant struct {
	tenant tenants.Tenant
	err    error
}

func (f fixedTenant) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return f.tenant, f.err
}

func validCreateSpaceInput(t *testing.T) CreateSpaceInput {
	t.Helper()
	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return CreateSpaceInput{TenantID: tenantID, Name: "Team", Slug: "team"}
}

func create(t *testing.T, service Service, edit func(*CreateSpaceInput)) (CreateSpaceInput, error) {
	t.Helper()
	repository := &capturingRepository{}
	input := validCreateSpaceInput(t)
	edit(&input)
	service.repository = repository
	_, err := service.CreateSpace(context.Background(), input)
	return repository.created, err
}

var ownSFUDefaults = NewSpaceDefaults{
	MediaPlane:          mediaplane.ProviderChalkSFU,
	RecordingPolicy:     artifactpolicy.RecordingAutomatic,
	TranscriptionPolicy: artifactpolicy.TranscriptionAutomatic,
}

func TestCreateSpaceAppliesNewSpaceDefaultsOnlyWhenOmitted(t *testing.T) {
	configured := NewServiceWithDefaultProvider(nil, mediaplane.ProviderCloudflareSFU).WithNewSpaceDefaults(ownSFUDefaults, fixedTenant{})

	omitted, err := create(t, configured, func(*CreateSpaceInput) {})
	if err != nil {
		t.Fatal(err)
	}
	if omitted.MediaPlane != mediaplane.ProviderChalkSFU.SettingName() || omitted.RecordingPolicy != artifactpolicy.RecordingAutomatic || !omitted.RecordingPolicySet ||
		omitted.TranscriptionPolicy != artifactpolicy.TranscriptionAutomatic || !omitted.TranscriptionPolicySet {
		t.Errorf("omitted fields got %+v", omitted)
	}

	explicit, err := create(t, configured, func(input *CreateSpaceInput) {
		input.MediaPlane, input.MediaPlaneSet = mediaplane.ProviderCloudflareSFU.SettingName(), true
		input.RecordingPolicy, input.RecordingPolicySet = artifactpolicy.RecordingManual, true
		input.TranscriptionPolicy, input.TranscriptionPolicySet = artifactpolicy.TranscriptionDisabled, true
	})
	if err != nil {
		t.Fatal(err)
	}
	if explicit.MediaPlane != mediaplane.ProviderCloudflareSFU.SettingName() || explicit.RecordingPolicy != artifactpolicy.RecordingManual || explicit.TranscriptionPolicy != artifactpolicy.TranscriptionDisabled {
		t.Errorf("explicit fields were overridden: %+v", explicit)
	}

	unconfigured, err := create(t, NewServiceWithDefaultProvider(nil, mediaplane.ProviderCloudflareSFU), func(*CreateSpaceInput) {})
	if err != nil {
		t.Fatal(err)
	}
	if unconfigured.RecordingPolicySet || unconfigured.TranscriptionPolicySet || unconfigured.MediaPlane != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Errorf("an unconfigured service changed the request: %+v", unconfigured)
	}
}

func TestNewSpacePlaneFollowsWhatTheTenantCanServe(t *testing.T) {
	cloudflare := mediaplane.ProviderCloudflareSFU.SettingName()
	cases := []struct {
		name   string
		tenant tenants.Tenant
		want   string
	}{
		{"no provider document", tenants.Tenant{}, mediaplane.ProviderChalkSFU.SettingName()},
		{"null provider document", tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`null`)}, mediaplane.ProviderChalkSFU.SettingName()},
		{"Chalk-managed provider document", tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"mode":"chalk_managed"}`)}, mediaplane.ProviderChalkSFU.SettingName()},
		{"tenant-managed Cloudflare credentials", tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"sfu":{"app_id":"a","app_secret":"s"}}}`)}, cloudflare},
		{"disabled provider document", tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"enabled":false,"mode":"chalk_managed"}`)}, cloudflare},
		{"unreadable provider document", tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`[`)}, cloudflare},
		{"Tenant default plane", tenants.Tenant{DefaultMediaPlane: &cloudflare}, cloudflare},
	}
	for _, c := range cases {
		service := NewServiceWithDefaultProvider(nil, mediaplane.ProviderCloudflareSFU).WithNewSpaceDefaults(ownSFUDefaults, fixedTenant{tenant: c.tenant})
		got, err := create(t, service, func(*CreateSpaceInput) {})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got.MediaPlane != c.want {
			t.Errorf("%s: got plane %q, want %q", c.name, got.MediaPlane, c.want)
		}
		if onNewPlane := c.want == mediaplane.ProviderChalkSFU.SettingName(); got.RecordingPolicySet != onNewPlane || got.TranscriptionPolicySet != onNewPlane {
			t.Errorf("%s: policy defaults set = %v/%v on plane %q", c.name, got.RecordingPolicySet, got.TranscriptionPolicySet, got.MediaPlane)
		}
	}
}

func TestNewSpacePlaneDefaultNeedsTheTenant(t *testing.T) {
	lookupFailed := errors.New("tenant lookup failed")
	service := NewServiceWithDefaultProvider(nil, mediaplane.ProviderCloudflareSFU).WithNewSpaceDefaults(ownSFUDefaults, fixedTenant{err: lookupFailed})
	if _, err := create(t, service, func(*CreateSpaceInput) {}); !errors.Is(err, lookupFailed) {
		t.Errorf("got %v, want the Tenant lookup error", err)
	}
}

// Under the own SFU as the deployment default, a request that names no plane creates a
// Space that inherits: no setting of its own, and Cloudflare in the legacy column, which both
// releases can serve. Create Space must not refuse it.
func TestCreateSpaceWithNoPlaneInheritsTheOwnSFUDefault(t *testing.T) {
	service := NewServiceWithDefaultProvider(nil, mediaplane.ProviderChalkSFU)
	got, err := create(t, service, func(*CreateSpaceInput) {})
	if err != nil {
		t.Fatalf("create under the own SFU default: %v", err)
	}
	if got.MediaPlaneSetting != nil || got.MediaPlane != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Errorf("stored setting %v, legacy plane %q, want no setting and %q", got.MediaPlaneSetting, got.MediaPlane, mediaplane.ProviderCloudflareSFU)
	}
}
