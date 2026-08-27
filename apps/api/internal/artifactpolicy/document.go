package artifactpolicy

import (
	"errors"
	"time"
)

var (
	ErrInvalidSnapshotSchema   = errors.New("invalid Artifact policy snapshot schema")
	ErrInvalidRecordingProfile = errors.New("invalid Recording profile")
)

type RecordingDocument struct {
	Mode             RecordingMode `json:"mode"`
	Profile          string        `json:"profile"`
	RetentionSeconds int64         `json:"retention_seconds"`
}

type TranscriptionDocument struct {
	Mode                  TranscriptionMode `json:"mode"`
	ProviderPolicyVersion string            `json:"provider_policy_version"`
	RetentionSeconds      int64             `json:"retention_seconds"`
	SourceWindowSeconds   int64             `json:"source_window_seconds"`
}

type Document struct {
	SchemaVersion string                `json:"schema_version"`
	Recording     RecordingDocument     `json:"recording"`
	Transcription TranscriptionDocument `json:"transcription"`
}

func (snapshot Snapshot) Document() (Document, error) {
	if snapshot.Recording.Retention%time.Second != 0 || snapshot.Transcription.Retention%time.Second != 0 || snapshot.Transcription.SourceWindow%time.Second != 0 {
		return Document{}, ErrInvalidRetention
	}
	document := Document{
		SchemaVersion: snapshot.SchemaVersion,
		Recording: RecordingDocument{
			Mode:             snapshot.Recording.Mode,
			Profile:          snapshot.Recording.Profile,
			RetentionSeconds: int64(snapshot.Recording.Retention / time.Second),
		},
		Transcription: TranscriptionDocument{
			Mode:                  snapshot.Transcription.Mode,
			ProviderPolicyVersion: snapshot.Transcription.ProviderPolicyVersion,
			RetentionSeconds:      int64(snapshot.Transcription.Retention / time.Second),
			SourceWindowSeconds:   int64(snapshot.Transcription.SourceWindow / time.Second),
		},
	}
	if err := document.Validate(); err != nil {
		return Document{}, err
	}
	return document, nil
}

func (document Document) Validate() error {
	if document.SchemaVersion != SnapshotSchemaVersion {
		return ErrInvalidSnapshotSchema
	}
	if err := document.Recording.Mode.Validate(); err != nil {
		return err
	}
	if document.Recording.Profile != RecordingProfile {
		return ErrInvalidRecordingProfile
	}
	if err := document.Transcription.Mode.Validate(); err != nil {
		return err
	}
	if document.Recording.RetentionSeconds < 0 ||
		document.Recording.RetentionSeconds > MaximumRetentionSeconds ||
		document.Transcription.RetentionSeconds < 0 ||
		document.Transcription.RetentionSeconds > MaximumRetentionSeconds {
		return ErrInvalidRetention
	}
	if document.Transcription.SourceWindowSeconds < 0 || document.Transcription.SourceWindowSeconds > int64(MaximumSourceWindow/time.Second) {
		return ErrInvalidSourceWindow
	}
	if document.Transcription.Mode != TranscriptionDisabled {
		if document.Transcription.SourceWindowSeconds == 0 {
			return ErrInvalidSourceWindow
		}
		if document.Transcription.ProviderPolicyVersion == "" {
			return ErrMissingProviderPolicy
		}
	}
	return nil
}
