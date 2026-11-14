package tenants

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func seconds(n int64) OptionalInt64 { return OptionalInt64{Set: true, Value: &n} }

func TestPrepareArtifactPolicyUpdate(t *testing.T) {
	tooLong := int64(artifactpolicy.MaximumRetentionSeconds) + 1
	negative := int64(-1)
	tooWide := int64(artifactpolicy.MaximumSourceWindow.Seconds()) + 1

	rejected := []struct {
		name  string
		input ArtifactPolicyUpdate
		want  error
	}{
		{"null ceiling", ArtifactPolicyUpdate{TranscriptionCeiling: utilities.OptionalString{Set: true}}, ErrInvalidArtifactPolicy},
		{"unknown ceiling", ArtifactPolicyUpdate{TranscriptionCeiling: utilities.OptionalString{Set: true, Value: text("sometimes")}}, artifactpolicy.ErrInvalidTranscriptionMode},
		{"null default mode", ArtifactPolicyUpdate{TranscriptionDefaultMode: utilities.OptionalString{Set: true}}, ErrInvalidArtifactPolicy},
		{"unknown default mode", ArtifactPolicyUpdate{TranscriptionDefaultMode: utilities.OptionalString{Set: true, Value: text("x")}}, artifactpolicy.ErrInvalidTranscriptionMode},
		{"null provider policy", ArtifactPolicyUpdate{ProviderPolicyVersion: utilities.OptionalString{Set: true}}, artifactpolicy.ErrMissingProviderPolicy},
		{"blank provider policy", ArtifactPolicyUpdate{ProviderPolicyVersion: utilities.OptionalString{Set: true, Value: text("  ")}}, artifactpolicy.ErrMissingProviderPolicy},
		{"null recording retention", ArtifactPolicyUpdate{RecordingRetentionSeconds: OptionalInt64{Set: true}}, artifactpolicy.ErrInvalidRetention},
		{"negative recording retention", ArtifactPolicyUpdate{RecordingRetentionSeconds: OptionalInt64{Set: true, Value: &negative}}, artifactpolicy.ErrInvalidRetention},
		{"long transcript retention", ArtifactPolicyUpdate{TranscriptRetentionSeconds: OptionalInt64{Set: true, Value: &tooLong}}, artifactpolicy.ErrInvalidRetention},
		{"null source window", ArtifactPolicyUpdate{TranscriptionSourceWindowSeconds: OptionalInt64{Set: true}}, artifactpolicy.ErrInvalidSourceWindow},
		{"negative source window", ArtifactPolicyUpdate{TranscriptionSourceWindowSeconds: OptionalInt64{Set: true, Value: &negative}}, artifactpolicy.ErrInvalidSourceWindow},
		{"wide source window", ArtifactPolicyUpdate{TranscriptionSourceWindowSeconds: OptionalInt64{Set: true, Value: &tooWide}}, artifactpolicy.ErrInvalidSourceWindow},
	}
	for _, test := range rejected {
		if err := prepareArtifactPolicyUpdate(&test.input); !errors.Is(err, test.want) {
			t.Errorf("%s: error = %v, want %v", test.name, err, test.want)
		}
	}

	accepted := ArtifactPolicyUpdate{
		TranscriptionCeiling:             utilities.OptionalString{Set: true, Value: text(" automatic ")},
		TranscriptionDefaultMode:         utilities.OptionalString{Set: true, Value: text("on_demand")},
		ProviderPolicyVersion:            utilities.OptionalString{Set: true, Value: text(" v1 ")},
		RecordingRetentionSeconds:        seconds(0),
		TranscriptRetentionSeconds:       seconds(artifactpolicy.MaximumRetentionSeconds),
		TranscriptionSourceWindowSeconds: seconds(60),
	}
	if err := prepareArtifactPolicyUpdate(&accepted); err != nil {
		t.Fatal(err)
	}
	if *accepted.TranscriptionCeiling.Value != "automatic" || *accepted.ProviderPolicyVersion.Value != "v1" {
		t.Fatalf("values were not trimmed: %q %q", *accepted.TranscriptionCeiling.Value, *accepted.ProviderPolicyVersion.Value)
	}
	if err := prepareArtifactPolicyUpdate(&ArtifactPolicyUpdate{}); err != nil {
		t.Fatalf("an empty update must pass: %v", err)
	}
	if err := prepareArtifactPolicyUpdate(&ArtifactPolicyUpdate{TranscriptLanguage: artifactpolicy.OptionalTranscriptLanguage{Set: true}}); !errors.Is(err, ErrInvalidArtifactPolicy) {
		t.Fatalf("null transcript language error = %v", err)
	}
}
