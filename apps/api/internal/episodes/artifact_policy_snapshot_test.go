package episodes

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestValidateConfigSnapshotAcceptsVersionedArtifactPolicy(t *testing.T) {
	raw := json.RawMessage(`{
		"admission_policy":{"mode":"open"},
		"roles":{"observer":["subscribe"]},
		"default_episode_duration_seconds":3600,
		"maximum_episode_duration_seconds":7200,
		"linger_window_seconds":30,
		"artifact_policy":{
			"schema_version":"episode_config.v2",
			"recording":{"mode":"automatic","profile":"composite_720p_v1","retention_seconds":2592000},
			"transcription":{"mode":"on_demand","provider_policy_version":"provider-v1","retention_seconds":2592000,"source_window_seconds":86400}
		}
	}`)

	encoded, snapshot, err := validateConfigSnapshot(raw)
	if err != nil {
		t.Fatalf("validate config snapshot: %v", err)
	}
	if len(encoded) == 0 || snapshot.ArtifactPolicy == nil {
		t.Fatal("validated snapshot omitted Artifact policy")
	}
	if snapshot.ArtifactPolicy.Transcription.SourceWindowSeconds != 86400 {
		t.Fatalf("source window seconds = %d, want 86400", snapshot.ArtifactPolicy.Transcription.SourceWindowSeconds)
	}
}

func TestValidateConfigSnapshotRejectsUnknownRecordingProfile(t *testing.T) {
	raw := json.RawMessage(`{
		"admission_policy":{"mode":"open"},
		"roles":{"observer":["subscribe"]},
		"default_episode_duration_seconds":3600,
		"maximum_episode_duration_seconds":7200,
		"linger_window_seconds":30,
		"artifact_policy":{
			"schema_version":"episode_config.v2",
			"recording":{"mode":"automatic","profile":"unknown","retention_seconds":2592000},
			"transcription":{"mode":"disabled","provider_policy_version":"provider-v1","retention_seconds":2592000,"source_window_seconds":86400}
		}
	}`)

	_, _, err := validateConfigSnapshot(raw)
	if !errors.Is(err, ErrInvalidConfigSnapshot) {
		t.Fatalf("validate config snapshot error = %v, want %v", err, ErrInvalidConfigSnapshot)
	}
}
