package recordingpresentation

import (
	"errors"
	"testing"
)

func TestSourceIDCrossRuntimeVector(t *testing.T) {
	t.Parallel()

	got, err := SourceID(MediaSourceIdentity{
		RecordingID:           "00000000-0000-4000-8000-000000000001",
		ParticipantID:         "00000000-0000-4000-8000-000000000005",
		ParticipantGeneration: 2,
		Kind:                  MediaKindScreenShare,
		TrackID:               "publication-track-7",
		Epoch:                 3,
	})
	if err != nil {
		t.Fatalf("derive source id: %v", err)
	}
	const want = "rps_0972a3f444e561d341205c80536b7725a86c5ac55ffad05905c9e8275664fa03"
	if got != want {
		t.Fatalf("source id = %q, want %q", got, want)
	}
}

func TestSourceIDRejectsIncompleteIdentity(t *testing.T) {
	t.Parallel()

	_, err := SourceID(MediaSourceIdentity{Kind: MediaKindCamera})
	if !errors.Is(err, ErrInvalidSourceIdentity) {
		t.Fatalf("error = %v, want %v", err, ErrInvalidSourceIdentity)
	}
}
