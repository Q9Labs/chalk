package postgres

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
)

func TestArtifactPolicyDocumentResolvesLockedFacts(t *testing.T) {
	tenant := artifactpolicy.TenantPolicy{
		TranscriptionCeiling:      artifactpolicy.TranscriptionAutomatic,
		TranscriptionDefault:      artifactpolicy.TranscriptionOnDemand,
		ProviderPolicyVersion:     "provider.v1",
		RecordingRetention:        24 * time.Hour,
		TranscriptRetention:       12 * time.Hour,
		TranscriptionSourceWindow: time.Hour,
	}
	for _, recording := range []artifactpolicy.RecordingMode{
		artifactpolicy.RecordingDisabled,
		artifactpolicy.RecordingManual,
		artifactpolicy.RecordingAutomatic,
	} {
		for _, transcription := range []artifactpolicy.TranscriptionMode{
			artifactpolicy.TranscriptionDisabled,
			artifactpolicy.TranscriptionOnDemand,
			artifactpolicy.TranscriptionAutomatic,
		} {
			raw, err := artifactPolicyDocument(tenant, artifactpolicy.SpacePolicy{Recording: recording, Transcription: transcription})
			if err != nil {
				t.Fatalf("resolve %q/%q: %v", recording, transcription, err)
			}
			var document artifactpolicy.Document
			if err := json.Unmarshal(raw, &document); err != nil {
				t.Fatalf("decode %q/%q: %v", recording, transcription, err)
			}
			if err := document.Validate(); err != nil {
				t.Fatalf("validate %q/%q: %v", recording, transcription, err)
			}
			if document.Recording.Mode != recording {
				t.Fatalf("recording mode = %q, want %q", document.Recording.Mode, recording)
			}
			if document.Transcription.Mode != transcription {
				t.Fatalf("transcription mode = %q, want %q", document.Transcription.Mode, transcription)
			}
		}
	}
}

func TestArtifactPolicyDocumentClampsDisabledTenant(t *testing.T) {
	raw, err := artifactPolicyDocument(artifactpolicy.TenantPolicy{
		TranscriptionCeiling: artifactpolicy.TranscriptionDisabled,
		TranscriptionDefault: artifactpolicy.TranscriptionDisabled,
		RecordingRetention:   time.Hour,
		TranscriptRetention:  time.Hour,
	}, artifactpolicy.SpacePolicy{
		Recording:     artifactpolicy.RecordingAutomatic,
		Transcription: artifactpolicy.TranscriptionAutomatic,
	})
	if err != nil {
		t.Fatalf("resolve disabled tenant: %v", err)
	}
	var document artifactpolicy.Document
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("decode disabled tenant: %v", err)
	}
	if document.Transcription.Mode != artifactpolicy.TranscriptionDisabled || document.Transcription.SourceWindowSeconds != 0 || document.Transcription.ProviderPolicyVersion != "" {
		t.Fatalf("disabled tenant snapshot = %#v", document.Transcription)
	}
}
