package artifactpolicy_test

import (
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
)

func TestResolveTranscriptionPolicyMatrix(t *testing.T) {
	for _, test := range []struct {
		name    string
		ceiling artifactpolicy.TranscriptionMode
		space   artifactpolicy.TranscriptionMode
		want    artifactpolicy.TranscriptionMode
	}{
		{name: "disabled ceiling disables disabled", ceiling: artifactpolicy.TranscriptionDisabled, space: artifactpolicy.TranscriptionDisabled, want: artifactpolicy.TranscriptionDisabled},
		{name: "disabled ceiling disables on demand", ceiling: artifactpolicy.TranscriptionDisabled, space: artifactpolicy.TranscriptionOnDemand, want: artifactpolicy.TranscriptionDisabled},
		{name: "disabled ceiling disables automatic", ceiling: artifactpolicy.TranscriptionDisabled, space: artifactpolicy.TranscriptionAutomatic, want: artifactpolicy.TranscriptionDisabled},
		{name: "on demand ceiling preserves disabled", ceiling: artifactpolicy.TranscriptionOnDemand, space: artifactpolicy.TranscriptionDisabled, want: artifactpolicy.TranscriptionDisabled},
		{name: "on demand ceiling preserves on demand", ceiling: artifactpolicy.TranscriptionOnDemand, space: artifactpolicy.TranscriptionOnDemand, want: artifactpolicy.TranscriptionOnDemand},
		{name: "on demand ceiling clamps automatic", ceiling: artifactpolicy.TranscriptionOnDemand, space: artifactpolicy.TranscriptionAutomatic, want: artifactpolicy.TranscriptionOnDemand},
		{name: "automatic ceiling preserves disabled", ceiling: artifactpolicy.TranscriptionAutomatic, space: artifactpolicy.TranscriptionDisabled, want: artifactpolicy.TranscriptionDisabled},
		{name: "automatic ceiling preserves on demand", ceiling: artifactpolicy.TranscriptionAutomatic, space: artifactpolicy.TranscriptionOnDemand, want: artifactpolicy.TranscriptionOnDemand},
		{name: "automatic ceiling preserves automatic", ceiling: artifactpolicy.TranscriptionAutomatic, space: artifactpolicy.TranscriptionAutomatic, want: artifactpolicy.TranscriptionAutomatic},
	} {
		t.Run(test.name, func(t *testing.T) {
			tenant := validTenantPolicy(test.ceiling)
			space := artifactpolicy.SpacePolicy{Recording: artifactpolicy.RecordingManual, Transcription: test.space}
			snapshot, err := artifactpolicy.Resolve(tenant, space)
			if err != nil {
				t.Fatalf("resolve policy: %v", err)
			}
			if snapshot.Transcription.Mode != test.want {
				t.Fatalf("Transcription mode = %q, want %q", snapshot.Transcription.Mode, test.want)
			}
			if snapshot.SchemaVersion != artifactpolicy.SnapshotSchemaVersion {
				t.Fatalf("schema version = %q, want %q", snapshot.SchemaVersion, artifactpolicy.SnapshotSchemaVersion)
			}
			if snapshot.Recording.Profile != artifactpolicy.RecordingProfile {
				t.Fatalf("Recording profile = %q, want %q", snapshot.Recording.Profile, artifactpolicy.RecordingProfile)
			}
		})
	}
}

func TestTenantPolicyRejectsInvalidBoundaries(t *testing.T) {
	for _, test := range []struct {
		name   string
		policy artifactpolicy.TenantPolicy
		want   error
	}{
		{name: "default exceeds ceiling", policy: artifactpolicy.TenantPolicy{TranscriptionCeiling: artifactpolicy.TranscriptionOnDemand, TranscriptionDefault: artifactpolicy.TranscriptionAutomatic, ProviderPolicyVersion: "provider-v1", TranscriptionSourceWindow: time.Hour}, want: artifactpolicy.ErrDefaultExceedsCeiling},
		{name: "enabled source missing", policy: artifactpolicy.TenantPolicy{TranscriptionCeiling: artifactpolicy.TranscriptionAutomatic, TranscriptionDefault: artifactpolicy.TranscriptionDisabled, ProviderPolicyVersion: "provider-v1"}, want: artifactpolicy.ErrInvalidSourceWindow},
		{name: "source exceeds v1 ceiling", policy: artifactpolicy.TenantPolicy{TranscriptionCeiling: artifactpolicy.TranscriptionAutomatic, TranscriptionDefault: artifactpolicy.TranscriptionDisabled, ProviderPolicyVersion: "provider-v1", TranscriptionSourceWindow: artifactpolicy.MaximumSourceWindow + time.Second}, want: artifactpolicy.ErrInvalidSourceWindow},
		{name: "provider policy missing", policy: artifactpolicy.TenantPolicy{TranscriptionCeiling: artifactpolicy.TranscriptionAutomatic, TranscriptionDefault: artifactpolicy.TranscriptionDisabled, TranscriptionSourceWindow: time.Hour}, want: artifactpolicy.ErrMissingProviderPolicy},
		{name: "negative Recording retention", policy: artifactpolicy.TenantPolicy{TranscriptionCeiling: artifactpolicy.TranscriptionDisabled, TranscriptionDefault: artifactpolicy.TranscriptionDisabled, RecordingRetention: -time.Second}, want: artifactpolicy.ErrInvalidRetention},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.policy.Validate(); !errors.Is(err, test.want) {
				t.Fatalf("Validate() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestTenantPolicyAcceptsMaximumRetention(t *testing.T) {
	maximum := time.Duration(artifactpolicy.MaximumRetentionSeconds) * time.Second
	policy := validTenantPolicy(artifactpolicy.TranscriptionDisabled)
	policy.RecordingRetention = maximum
	policy.TranscriptRetention = maximum

	if err := policy.Validate(); err != nil {
		t.Fatalf("Validate() error = %v, want nil", err)
	}
}

func TestSeedSpacePolicyUsesTenantDefaultOnce(t *testing.T) {
	tenant := validTenantPolicy(artifactpolicy.TranscriptionAutomatic)
	tenant.TranscriptionDefault = artifactpolicy.TranscriptionOnDemand

	space, err := artifactpolicy.SeedSpacePolicy(tenant, artifactpolicy.RecordingAutomatic)
	if err != nil {
		t.Fatalf("seed Space policy: %v", err)
	}
	if space.Transcription != artifactpolicy.TranscriptionOnDemand {
		t.Fatalf("Transcription mode = %q, want %q", space.Transcription, artifactpolicy.TranscriptionOnDemand)
	}

	tenant.TranscriptionDefault = artifactpolicy.TranscriptionAutomatic
	snapshot, err := artifactpolicy.Resolve(tenant, space)
	if err != nil {
		t.Fatalf("resolve existing Space policy: %v", err)
	}
	if snapshot.Transcription.Mode != artifactpolicy.TranscriptionOnDemand {
		t.Fatalf("existing Space mode = %q, want %q", snapshot.Transcription.Mode, artifactpolicy.TranscriptionOnDemand)
	}
}

func TestSnapshotDocumentUsesSecondsAndValidatesProfile(t *testing.T) {
	snapshot, err := artifactpolicy.Resolve(
		validTenantPolicy(artifactpolicy.TranscriptionAutomatic),
		artifactpolicy.SpacePolicy{Recording: artifactpolicy.RecordingAutomatic, Transcription: artifactpolicy.TranscriptionOnDemand},
	)
	if err != nil {
		t.Fatalf("resolve policy: %v", err)
	}
	document, err := snapshot.Document()
	if err != nil {
		t.Fatalf("create snapshot document: %v", err)
	}
	if document.Transcription.SourceWindowSeconds != 3600 {
		t.Fatalf("source window seconds = %d, want 3600", document.Transcription.SourceWindowSeconds)
	}

	document.Recording.Profile = "unknown"
	if err := document.Validate(); !errors.Is(err, artifactpolicy.ErrInvalidRecordingProfile) {
		t.Fatalf("Validate() error = %v, want %v", err, artifactpolicy.ErrInvalidRecordingProfile)
	}
}

func TestDocumentRejectsRetentionAboveMaximum(t *testing.T) {
	snapshot, err := artifactpolicy.Resolve(
		validTenantPolicy(artifactpolicy.TranscriptionDisabled),
		artifactpolicy.SpacePolicy{Recording: artifactpolicy.RecordingAutomatic, Transcription: artifactpolicy.TranscriptionDisabled},
	)
	if err != nil {
		t.Fatalf("resolve policy: %v", err)
	}
	document, err := snapshot.Document()
	if err != nil {
		t.Fatalf("create snapshot document: %v", err)
	}

	document.Recording.RetentionSeconds = artifactpolicy.MaximumRetentionSeconds
	document.Transcription.RetentionSeconds = artifactpolicy.MaximumRetentionSeconds
	if err := document.Validate(); err != nil {
		t.Fatalf("Validate() at maximum error = %v, want nil", err)
	}

	for _, test := range []struct {
		name   string
		mutate func(*artifactpolicy.Document)
	}{
		{name: "Recording", mutate: func(value *artifactpolicy.Document) {
			value.Recording.RetentionSeconds = artifactpolicy.MaximumRetentionSeconds + 1
		}},
		{name: "transcript", mutate: func(value *artifactpolicy.Document) {
			value.Transcription.RetentionSeconds = artifactpolicy.MaximumRetentionSeconds + 1
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := document
			test.mutate(&candidate)
			if err := candidate.Validate(); !errors.Is(err, artifactpolicy.ErrInvalidRetention) {
				t.Fatalf("Validate() error = %v, want %v", err, artifactpolicy.ErrInvalidRetention)
			}
		})
	}
}

func validTenantPolicy(ceiling artifactpolicy.TranscriptionMode) artifactpolicy.TenantPolicy {
	policy := artifactpolicy.TenantPolicy{
		TranscriptionCeiling:      ceiling,
		TranscriptionDefault:      artifactpolicy.TranscriptionDisabled,
		RecordingRetention:        30 * 24 * time.Hour,
		TranscriptRetention:       30 * 24 * time.Hour,
		ProviderPolicyVersion:     "provider-v1",
		TranscriptionSourceWindow: time.Hour,
	}
	if ceiling == artifactpolicy.TranscriptionDisabled {
		policy.ProviderPolicyVersion = ""
		policy.TranscriptionSourceWindow = 0
	}
	return policy
}
