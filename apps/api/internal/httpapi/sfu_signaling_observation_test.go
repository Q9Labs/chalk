package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPartialSFUTracksResponseRequiresClientOptIn(t *testing.T) {
	providerErr := errors.New("one remote feed is missing")
	response := mediaplane.TracksResponse{Tracks: []mediaplane.Track{remoteObservationTrack("screen-connection", "screen")}}
	for _, allowPartial := range []bool{false, true} {
		got, err := partialSFUTracksResponse(sfuTracksEndpointRequest{AllowPartialRemoteTracks: allowPartial}, response, providerErr)
		if allowPartial {
			if err != nil || len(got.Tracks) != 1 {
				t.Fatalf("opted-in response = %#v, error = %v", got, err)
			}
		} else if !errors.Is(err, providerErr) || len(got.Tracks) != 0 || got.SessionDescription != nil {
			t.Fatalf("legacy client received a partial response: %#v, error = %v", got, err)
		}
	}
}

func TestSFUTracksDecoderRequiresExplicitPartialReplyQuery(t *testing.T) {
	for _, value := range []string{"", "false", "true", "invalid"} {
		t.Run(value, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/tracks?allow_partial_remote_tracks="+value, strings.NewReader(`{"connection_id":"receiver","tracks":[]}`))
			route := chi.NewRouteContext()
			for _, name := range []string{"tenant_id", "space_id", "episode_id", "participant_id"} {
				route.URLParams.Add(name, "11111111-1111-4111-8111-111111111111")
			}
			request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
			decoded, err := decodeSFUTracksRequest(request)
			if err != nil || decoded.AllowPartialRemoteTracks != (value == "true") {
				t.Fatalf("query %q: opted in = %t, error = %v", value, decoded.AllowPartialRemoteTracks, err)
			}
		})
	}
}

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

func TestRemoteTrackObservationRejectsUnrelatedProviderAbsence(t *testing.T) {
	request := sfuTracksEndpointRequest{Body: sfuTracksRequest{Tracks: []mediaplane.Track{remoteObservationTrack("remote-connection", "remote-track")}}}
	_, ok := remoteTrackObservation(request, []mediaplane.RemoteTrackIdentity{{ConnectionID: "other-connection", TrackName: "other-track"}})
	if ok {
		t.Fatal("unrelated provider absence produced an observation")
	}
}

func TestRemoteTrackObservationForFailureRequiresExactEvidence(t *testing.T) {
	request := sfuTracksEndpointRequest{Body: sfuTracksRequest{Tracks: []mediaplane.Track{remoteObservationTrack("remote-connection", "remote-track")}}}
	err := fmt.Errorf("wrapped provider failure: %w", remoteTrackObservationFailure{
		missing: []mediaplane.RemoteTrackIdentity{{ConnectionID: "remote-connection", TrackName: "remote-track"}},
	})
	if _, ok := remoteTrackObservationForFailure(request, err); ok {
		t.Fatal("inexact provider failure produced a recovery observation")
	}
}

func TestRemoteTrackObservationForFailureUsesExactRequestedEvidence(t *testing.T) {
	request := sfuTracksEndpointRequest{Body: sfuTracksRequest{Tracks: []mediaplane.Track{remoteObservationTrack("remote-connection", "remote-track")}}}
	err := fmt.Errorf("wrapped provider failure: %w", remoteTrackObservationFailure{
		missing: []mediaplane.RemoteTrackIdentity{{ConnectionID: "remote-connection", TrackName: "remote-track"}},
		exact:   true,
	})
	observation, ok := remoteTrackObservationForFailure(request, err)
	if !ok || len(observation.Missing) != 1 || observation.Missing[0].ConnectionID != "remote-connection" || observation.Missing[0].TrackName != "remote-track" {
		t.Fatalf("observation = %#v, available = %t", observation, ok)
	}
}

func TestRemoteTrackPartialObservationReportsOnlyUnreturnedRequests(t *testing.T) {
	request := sfuTracksEndpointRequest{Body: sfuTracksRequest{Tracks: []mediaplane.Track{
		remoteObservationTrack("screen-connection", "screen"),
		remoteObservationTrack("camera-connection", "camera"),
	}}}
	response := mediaplane.TracksResponse{Tracks: []mediaplane.Track{remoteObservationTrack("screen-connection", "screen")}}

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
	exact   bool
}

func (remoteTrackObservationFailure) Error() string {
	return "provider failure"
}

func (e remoteTrackObservationFailure) MissingRemoteTracks() []mediaplane.RemoteTrackIdentity {
	return e.missing
}

func (e remoteTrackObservationFailure) ExactRemoteTrackAbsence() bool {
	return e.exact
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
