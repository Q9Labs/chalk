package spaces

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestSpaceCreateReplaysAnOmittedLegacyPlane(t *testing.T) {
	previous := CreateSpaceInput{Name: "Example", Slug: "example", MediaPlane: mediaplane.PlaneCloudflare,
		RecordingPolicy: artifactpolicy.RecordingDisabled, TranscriptionPolicy: artifactpolicy.TranscriptionDisabled}
	stored, err := createFingerprint(previous)
	if err != nil {
		t.Fatal(err)
	}

	current := previous
	current.MediaPlane = mediaplane.ProviderChalkSFU.SettingName()
	current.RecordingPolicy = artifactpolicy.RecordingManual
	current.RecordingPolicySet = true
	if err := current.setCreateFingerprints(false, false); err != nil {
		t.Fatal(err)
	}
	if !current.MatchesRequestFingerprint(stored[:]) {
		t.Fatal("identical request did not replay after the default plane changed")
	}

	current.Name = "A different Space"
	if err := current.setCreateFingerprints(false, false); err != nil {
		t.Fatal(err)
	}
	if current.MatchesRequestFingerprint(stored[:]) {
		t.Fatal("a different request replayed a previous Space")
	}
}
