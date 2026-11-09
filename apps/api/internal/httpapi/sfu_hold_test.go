package httpapi

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// holdPlane records what the node was asked, in order with the registry's calls.
type holdPlane struct {
	mediaplane.Plane
	calls    *[]string
	response mediaplane.TracksResponse
}

func (p holdPlane) HoldsPublications() {}

func (p holdPlane) UpdateTracks(context.Context, mediaplane.UpdateTracksRequest) (mediaplane.TracksResponse, error) {
	*p.calls = append(*p.calls, "node")
	return p.response, nil
}

type holdRegistry struct {
	mediapublications.Registry
	calls    *[]string
	current  bool
	recorded []mediapublications.AvailabilityInput
}

func (r *holdRegistry) PrepareClose(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	*r.calls = append(*r.calls, "prepare")
	return mediapublications.CloseDecision{ProviderCloseRequired: r.current}, nil
}

func (r *holdRegistry) RecordPublicationAvailability(_ context.Context, input mediapublications.AvailabilityInput) error {
	*r.calls = append(*r.calls, "record")
	r.recorded = append(r.recorded, input)
	return nil
}

func holdFixture(t *testing.T) (context.Context, sfuUpdateTracksEndpointRequest) {
	t.Helper()
	ids := make([]utilities.ID, 4)
	for index := range ids {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		ids[index] = id
	}
	ctx := accessgrants.WithSubject(context.Background(), accessgrants.Subject{ParticipantGeneration: 3})
	return ctx, sfuUpdateTracksEndpointRequest{TenantID: ids[0], SpaceID: ids[1], EpisodeID: ids[2], ParticipantID: ids[3], Body: sfuUpdateTracksRequest{ConnectionID: "conn"}}
}

func localUpdate(paused bool) mediaplane.UpdateTracksRequest {
	return mediaplane.UpdateTracksRequest{ConnectionID: "conn", Tracks: []mediaplane.Track{{Location: "local", Mid: "1", TrackName: "cam", Source: "camera", PublicationID: "pub", Paused: &paused}}}
}

func TestHoldChangesTheNodeThenRecordsVisibilityOnTheSamePublication(t *testing.T) {
	for _, paused := range []bool{true, false} {
		ctx, request := holdFixture(t)
		var calls []string
		registry := &holdRegistry{calls: &calls, current: true}
		service := mediaplane.NewService(holdPlane{calls: &calls})
		if _, err := holdLocalTracks(ctx, request, &service, registry, localUpdate(paused)); err != nil {
			t.Fatal(err)
		}
		if got := len(calls); got != 3 || calls[0] != "prepare" || calls[1] != "node" || calls[2] != "record" {
			t.Fatalf("paused=%v: calls %v, want prepare, node, record", paused, calls)
		}
		if got := registry.recorded[0]; got.PublicationID != "pub" || got.Source != "camera" || got.Enabled == paused {
			t.Fatalf("paused=%v: recorded %+v", paused, got)
		}
	}
}

func TestHoldOfAPublicationTheRegistryNoLongerHoldsTouchesNothing(t *testing.T) {
	ctx, request := holdFixture(t)
	var calls []string
	service := mediaplane.NewService(holdPlane{calls: &calls})
	_, err := holdLocalTracks(ctx, request, &service, &holdRegistry{calls: &calls, current: false}, localUpdate(true))
	if !errors.Is(err, mediapublications.ErrInvalidPublication) || len(calls) != 1 {
		t.Fatalf("err %v, calls %v: a stale publication must reach neither the node nor the registry", err, calls)
	}
}

func TestHoldTheNodeCannotFindIsNotRecorded(t *testing.T) {
	ctx, request := holdFixture(t)
	var calls []string
	missing := mediaplane.TracksResponse{TrackErrors: []mediaplane.TrackError{{TrackName: "cam", Code: "track_not_found"}}}
	service := mediaplane.NewService(holdPlane{calls: &calls, response: missing})
	response, err := holdLocalTracks(ctx, request, &service, &holdRegistry{calls: &calls, current: true}, localUpdate(true))
	if err != nil || len(response.TrackErrors) != 1 || len(calls) != 2 {
		t.Fatalf("response %+v, err %v, calls %v: the track error must come back with no record", response, err, calls)
	}
}

func TestHoldRefusesARequestThatMixesInASubscription(t *testing.T) {
	ctx, request := holdFixture(t)
	var calls []string
	service := mediaplane.NewService(holdPlane{calls: &calls})
	update := localUpdate(true)
	update.Tracks = append(update.Tracks, mediaplane.Track{Location: "remote", Mid: "2", TrackName: "mic", SessionID: "peer"})
	if _, err := holdLocalTracks(ctx, request, &service, &holdRegistry{calls: &calls, current: true}, update); !errors.Is(err, mediaplane.ErrInvalidSignalRequest) || len(calls) != 0 {
		t.Fatalf("err %v, calls %v", err, calls)
	}
}

func TestHoldRecordsTheTracksTheNodeParkedWhenAnotherInTheBatchFailed(t *testing.T) {
	ctx, request := holdFixture(t)
	var calls []string
	paused := true
	update := localUpdate(paused)
	update.Tracks = append(update.Tracks, mediaplane.Track{Location: "local", Mid: "2", TrackName: "mic", Source: "microphone", PublicationID: "pub-mic", Paused: &paused})
	partial := mediaplane.TracksResponse{TrackErrors: []mediaplane.TrackError{{TrackName: "cam", Code: "track_not_found"}}}
	registry := &holdRegistry{calls: &calls, current: true}
	service := mediaplane.NewService(holdPlane{calls: &calls, response: partial})
	response, err := holdLocalTracks(ctx, request, &service, registry, update)
	if err != nil || len(response.TrackErrors) != 1 {
		t.Fatalf("response %+v, err %v: the failed track must still be reported", response, err)
	}
	if len(registry.recorded) != 1 || registry.recorded[0].PublicationID != "pub-mic" || registry.recorded[0].Enabled {
		t.Fatalf("recorded %+v: only the microphone the node parked belongs in the registry", registry.recorded)
	}
}

func TestHoldRecordsTheTracksTheNodeResumedWhenAnotherInTheBatchFailed(t *testing.T) {
	ctx, request := holdFixture(t)
	var calls []string
	resumed := false
	update := localUpdate(resumed)
	update.Tracks = append(update.Tracks, mediaplane.Track{Location: "local", Mid: "2", TrackName: "mic", Source: "microphone", PublicationID: "pub-mic", Paused: &resumed})
	partial := mediaplane.TracksResponse{TrackErrors: []mediaplane.TrackError{{TrackName: "cam", Code: "track_not_found"}}}
	registry := &holdRegistry{calls: &calls, current: true}
	service := mediaplane.NewService(holdPlane{calls: &calls, response: partial})
	if _, err := holdLocalTracks(ctx, request, &service, registry, update); err != nil {
		t.Fatal(err)
	}
	if len(registry.recorded) != 1 || registry.recorded[0].PublicationID != "pub-mic" || !registry.recorded[0].Enabled {
		t.Fatalf("recorded %+v: the resumed microphone must be visible again", registry.recorded)
	}
}
