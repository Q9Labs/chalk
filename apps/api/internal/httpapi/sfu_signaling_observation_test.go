package httpapi

import (
	"fmt"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRemoteTrackObservationUsesOnlyRequestedMissingIdentities(t *testing.T) {
	request := sfuTracksEndpointRequest{
		TenantID:  remoteObservationTestID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID: remoteObservationTestID(t, "22222222-2222-4222-8222-222222222222"),
		Body: sfuTracksRequest{Tracks: []mediaplane.Track{
			{Location: "local", TrackName: "local-track"},
			remoteObservationTrack("remote-connection", "remote-track"),
		}},
	}
	observation, ok := remoteTrackObservation(request, []mediaplane.RemoteTrackIdentity{
		{ConnectionID: "remote-connection", TrackName: "remote-track"},
		{ConnectionID: "unrequested-connection", TrackName: "unrequested-track"},
	})
	if !ok {
		t.Fatal("remote observation missing")
	}
	if len(observation.Requested) != 1 || observation.Requested[0].ConnectionID != "remote-connection" || observation.Requested[0].TrackName != "remote-track" {
		t.Fatalf("requested identities = %#v", observation.Requested)
	}
	if len(observation.Missing) != 1 || observation.Missing[0] != observation.Requested[0] {
		t.Fatalf("missing identities = %#v", observation.Missing)
	}
}

func remoteObservationTestID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatalf("parse ID: %v", err)
	}
	return id
}

func remoteObservationTrack(connectionID, trackName string) mediaplane.Track {
	return mediaplane.Track{Location: "remote", SessionID: connectionID, TrackName: trackName}
}

func TestRemoteTrackObservationRejectsUnrelatedProviderAbsence(t *testing.T) {
	request := sfuTracksEndpointRequest{Body: sfuTracksRequest{Tracks: []mediaplane.Track{remoteObservationTrack("remote-connection", "remote-track")}}}
	_, ok := remoteTrackObservation(request, []mediaplane.RemoteTrackIdentity{{ConnectionID: "other-connection", TrackName: "other-track"}})
	if ok {
		t.Fatal("unrelated provider absence produced an observation")
	}
}

func TestRemoteTrackObservationForFailureRejectsUnrelatedProviderErrors(t *testing.T) {
	request := sfuTracksEndpointRequest{Body: sfuTracksRequest{Tracks: []mediaplane.Track{remoteObservationTrack("remote-connection", "remote-track")}}}
	err := fmt.Errorf("wrapped provider failure: %w", remoteTrackObservationFailure{
		missing: []mediaplane.RemoteTrackIdentity{{ConnectionID: "remote-connection", TrackName: "remote-track"}},
	})
	if _, ok := remoteTrackObservationForFailure(request, err); ok {
		t.Fatal("unrelated provider failure produced a recovery observation")
	}
}

func TestRemoteTrackPartialObservationReportsOnlyUnreturnedRequests(t *testing.T) {
	request := sfuTracksEndpointRequest{Body: sfuTracksRequest{Tracks: []mediaplane.Track{
		remoteObservationTrack("screen-connection", "screen"),
		remoteObservationTrack("camera-connection", "camera"),
	}}}
	response := mediaplane.TracksResponse{Tracks: []mediaplane.Track{
		remoteObservationTrack("screen-connection", "screen"),
	}}

	observation, ok := remoteTrackPartialObservation(request, response)
	if !ok {
		t.Fatal("partial response did not produce a bounded observation")
	}
	if len(observation.Missing) != 1 || observation.Missing[0].ConnectionID != "camera-connection" || observation.Missing[0].TrackName != "camera" {
		t.Fatalf("missing identities = %#v, want only camera", observation.Missing)
	}
}

type remoteTrackObservationFailure struct {
	missing []mediaplane.RemoteTrackIdentity
}

func (remoteTrackObservationFailure) Error() string {
	return "provider failure"
}

func (e remoteTrackObservationFailure) MissingRemoteTracks() []mediaplane.RemoteTrackIdentity {
	return e.missing
}

func (remoteTrackObservationFailure) ExactRemoteTrackAbsence() bool {
	return false
}
