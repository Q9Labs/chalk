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

func TestRemoteTrackEvidenceRequiresTypedProviderEvidence(t *testing.T) {
	err := fmt.Errorf("wrapped provider failure: %w", remoteTrackAbsenceTestError{exact: true, partial: true})
	if !IsExactRemoteTrackAbsence(err) {
		t.Fatal("exact remote-track absence = false, want true")
	}
	if !IsPartialRemoteTrackResponse(err) {
		t.Fatal("partial remote-track response = false, want true")
	}
	unrelated := fmt.Errorf("unrelated provider failure")
	if MissingRemoteTracks(unrelated) != nil || IsExactRemoteTrackAbsence(unrelated) || IsPartialRemoteTrackResponse(unrelated) {
		t.Fatal("unrelated error exposed remote-track evidence")
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
