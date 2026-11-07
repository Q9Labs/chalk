package spaces

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestNewSpacesGetTheNewSpacePlane(t *testing.T) {
	cases := []struct {
		name    string
		service Service
		want    MediaPlaneProvider
		wantErr error
	}{
		{"no default", Service{}, "", nil},
		{"deployment default", NewServiceWithDefaultProvider(nil, MediaPlaneProviderCloudflareSFU), MediaPlaneProviderCloudflareSFU, nil},
		{"new Space plane replaces the default", NewServiceWithDefaultProvider(nil, MediaPlaneProviderCloudflareSFU).WithNewSpaceDefaults(NewSpaceDefaults{MediaPlane: MediaPlaneProviderChalkSFU}), MediaPlaneProviderChalkSFU, nil},
		{"own SFU deployment default is refused", NewServiceWithDefaultProvider(nil, MediaPlaneProviderChalkSFU), "", ErrInvalidMediaPlane},
	}
	for _, c := range cases {
		got, err := c.service.planeForNewSpace()
		if got != c.want || err != c.wantErr {
			t.Errorf("%s: got %q, %v; want %q, %v", c.name, got, err, c.want, c.wantErr)
		}
	}
}

type capturingRepository struct {
	Repository
	created CreateSpaceInput
}

func (r *capturingRepository) CreateSpace(_ context.Context, input CreateSpaceInput) (Space, error) {
	r.created = input
	return Space{}, nil
}

func validCreateSpaceInput(t *testing.T) CreateSpaceInput {
	t.Helper()
	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return CreateSpaceInput{TenantID: tenantID, Name: "Team", Slug: "team"}
}

func TestCreateSpaceAppliesNewSpacePolicyDefaultsOnlyWhenOmitted(t *testing.T) {
	defaults := NewSpaceDefaults{
		MediaPlane:          MediaPlaneProviderChalkSFU,
		RecordingPolicy:     artifactpolicy.RecordingAutomatic,
		TranscriptionPolicy: artifactpolicy.TranscriptionAutomatic,
	}
	everyone, err := ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	create := func(service Service, edit func(*CreateSpaceInput)) CreateSpaceInput {
		repository := &capturingRepository{}
		input := validCreateSpaceInput(t)
		edit(&input)
		service.repository = repository
		if _, err := service.CreateSpace(context.Background(), input); err != nil {
			t.Fatal(err)
		}
		return repository.created
	}
	configured := NewServiceWithDefaultProvider(nil, MediaPlaneProviderCloudflareSFU).WithChalkSFUAllowlist(everyone).WithNewSpaceDefaults(defaults)

	omitted := create(configured, func(*CreateSpaceInput) {})
	if omitted.MediaPlane != string(MediaPlaneProviderChalkSFU) || omitted.RecordingPolicy != artifactpolicy.RecordingAutomatic || !omitted.RecordingPolicySet ||
		omitted.TranscriptionPolicy != artifactpolicy.TranscriptionAutomatic || !omitted.TranscriptionPolicySet {
		t.Errorf("omitted fields got %+v", omitted)
	}

	explicit := create(configured, func(input *CreateSpaceInput) {
		input.MediaPlane, input.MediaPlaneSet = string(MediaPlaneProviderCloudflareSFU), true
		input.RecordingPolicy, input.RecordingPolicySet = artifactpolicy.RecordingManual, true
		input.TranscriptionPolicy, input.TranscriptionPolicySet = artifactpolicy.TranscriptionDisabled, true
	})
	if explicit.MediaPlane != string(MediaPlaneProviderCloudflareSFU) || explicit.RecordingPolicy != artifactpolicy.RecordingManual || explicit.TranscriptionPolicy != artifactpolicy.TranscriptionDisabled {
		t.Errorf("explicit fields were overridden: %+v", explicit)
	}

	unconfigured := create(NewServiceWithDefaultProvider(nil, MediaPlaneProviderCloudflareSFU), func(*CreateSpaceInput) {})
	if unconfigured.RecordingPolicySet || unconfigured.TranscriptionPolicySet || unconfigured.MediaPlane != string(MediaPlaneProviderCloudflareSFU) {
		t.Errorf("an unconfigured service changed the request: %+v", unconfigured)
	}
}
