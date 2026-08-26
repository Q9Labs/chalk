package mediaplane

import (
	"fmt"
	"testing"
)

func TestMissingRemoteTracksReturnsWrappedEvidenceDefensively(t *testing.T) {
	want := []RemoteTrackIdentity{{ConnectionID: "connection-1", TrackName: "track-1"}}
	err := fmt.Errorf("wrapped provider failure: %w", remoteTrackAbsenceTestError{identities: want})

	got := MissingRemoteTracks(err)
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("identities = %#v, want %#v", got, want)
	}
	got[0].ConnectionID = "changed"

	again := MissingRemoteTracks(err)
	if len(again) != 1 || again[0] != want[0] {
		t.Fatalf("identities after caller mutation = %#v, want %#v", again, want)
	}
}

func TestMissingRemoteTracksReturnsNilWithoutEvidence(t *testing.T) {
	if got := MissingRemoteTracks(fmt.Errorf("unrelated provider failure")); got != nil {
		t.Fatalf("identities = %#v, want nil", got)
	}
}

func TestIsExactRemoteTrackAbsenceRequiresProviderEvidence(t *testing.T) {
	err := fmt.Errorf("wrapped provider failure: %w", remoteTrackAbsenceTestError{exact: true})
	if !IsExactRemoteTrackAbsence(err) {
		t.Fatal("exact remote-track absence = false, want true")
	}
	if IsExactRemoteTrackAbsence(fmt.Errorf("unrelated provider failure")) {
		t.Fatal("unrelated provider failure classified as exact remote-track absence")
	}
}

func TestIsPartialRemoteTrackResponseRequiresProviderEvidence(t *testing.T) {
	err := fmt.Errorf("wrapped provider failure: %w", remoteTrackAbsenceTestError{partial: true})
	if !IsPartialRemoteTrackResponse(err) {
		t.Fatal("wrapped partial remote-track response was not recognized")
	}
	if IsPartialRemoteTrackResponse(fmt.Errorf("unrelated provider failure")) {
		t.Fatal("unrelated provider failure was recognized as a partial remote-track response")
	}
}

type remoteTrackAbsenceTestError struct {
	identities []RemoteTrackIdentity
	exact      bool
	partial    bool
}

func (e remoteTrackAbsenceTestError) Error() string {
	return "provider failure"
}

func (e remoteTrackAbsenceTestError) MissingRemoteTracks() []RemoteTrackIdentity {
	return e.identities
}

func (e remoteTrackAbsenceTestError) ExactRemoteTrackAbsence() bool {
	return e.exact
}

func (e remoteTrackAbsenceTestError) PartialRemoteTrackResponse() bool {
	return e.partial
}
