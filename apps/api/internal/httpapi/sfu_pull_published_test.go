package httpapi

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type latestOnlyRegistry struct {
	mediapublications.Registry
	snapshot mediapublications.Snapshot
}

func (r latestOnlyRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	return r.snapshot, nil
}

func pullPublishedRequest(t *testing.T) sfuTracksEndpointRequest {
	t.Helper()
	self, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return sfuTracksEndpointRequest{ParticipantID: self, Body: sfuTracksRequest{ConnectionID: "connection-self", PullPublishedAudio: true}}
}

func publication(t *testing.T, participant utilities.ID, source, id string, enabled bool) provideroperations.Publication {
	t.Helper()
	return provideroperations.Publication{ParticipantID: participant, Source: source, Enabled: enabled, PublicationID: id}
}

func TestExpandPullPublishedAudioPullsOnlyOthersAudio(t *testing.T) {
	request := pullPublishedRequest(t)
	other, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	registry := latestOnlyRegistry{snapshot: mediapublications.Snapshot{Incarnation: 3, Sequence: 9, Publications: []provideroperations.Publication{
		publication(t, request.ParticipantID, "microphone", "self|microphone-self", true),
		publication(t, other, "microphone", "other|microphone-other", true),
		publication(t, other, "screen_audio", "other|screen-audio-other", true),
		publication(t, other, "camera", "other|camera-other", true),
		publication(t, other, "microphone", "other|microphone-muted", false),
		publication(t, other, "microphone", "not a publication id", true),
	}}}
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, nil)

	list, err := expandPullPublishedAudio(context.Background(), &request, &service, registry)
	if err != nil {
		t.Fatal(err)
	}

	want := []mediaplane.Track{
		{Location: "remote", SessionID: "other", TrackName: "microphone-other"},
		{Location: "remote", SessionID: "other", TrackName: "screen-audio-other"},
	}
	if fmt.Sprint(request.Body.Tracks) != fmt.Sprint(want) {
		t.Fatalf("tracks = %+v, want %+v", request.Body.Tracks, want)
	}
	if !request.AllowPartialRemoteTracks {
		t.Fatal("a pull-published request must allow partial remote tracks")
	}
	if list.Incarnation != 3 || list.Sequence != 9 || len(list.Publications) != 5 {
		t.Fatalf("list = %+v, want the Episode's enabled publications at 3/9", list)
	}
}

func TestExpandPullPublishedAudioCapsTracksAtTheRequestLimit(t *testing.T) {
	request := pullPublishedRequest(t)
	other, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	var publications []provideroperations.Publication
	for index := 0; index < mediaplane.MaxTracksPerRequest+4; index++ {
		publications = append(publications, publication(t, other, "microphone", fmt.Sprintf("other-%d|microphone", index), true))
	}
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, nil)

	if _, err := expandPullPublishedAudio(context.Background(), &request, &service, latestOnlyRegistry{snapshot: mediapublications.Snapshot{Publications: publications}}); err != nil {
		t.Fatal(err)
	}
	if got := len(request.Body.Tracks); got != mediaplane.MaxTracksPerRequest {
		t.Fatalf("tracks = %d, want %d", got, mediaplane.MaxTracksPerRequest)
	}
}

func TestExpandPullPublishedAudioRejectsRequestsItCannotServe(t *testing.T) {
	chalk := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, nil)
	cloudflare := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, nil)
	cases := map[string]struct {
		service *mediaplane.Service
		mutate  func(*sfuTracksEndpointRequest)
	}{
		"cloudflare plane": {&cloudflare, func(*sfuTracksEndpointRequest) {}},
		"with tracks":      {&chalk, func(r *sfuTracksEndpointRequest) { r.Body.Tracks = []mediaplane.Track{{Location: "remote"}} }},
		"with an offer": {&chalk, func(r *sfuTracksEndpointRequest) {
			r.Body.SessionDescription = &mediaplane.SessionDescription{Type: "offer"}
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			request := pullPublishedRequest(t)
			tc.mutate(&request)
			_, err := expandPullPublishedAudio(context.Background(), &request, tc.service, latestOnlyRegistry{})
			if !errors.Is(err, mediaplane.ErrInvalidSignalRequest) {
				t.Fatalf("err = %v, want ErrInvalidSignalRequest", err)
			}
		})
	}
}

func TestExpandPullPublishedAudioWithNoAudioRequestsNothing(t *testing.T) {
	request := pullPublishedRequest(t)
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, nil)
	if _, err := expandPullPublishedAudio(context.Background(), &request, &service, latestOnlyRegistry{}); err != nil {
		t.Fatal(err)
	}
	if len(request.Body.Tracks) != 0 {
		t.Fatalf("tracks = %+v, want none", request.Body.Tracks)
	}
}
