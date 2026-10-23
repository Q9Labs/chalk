package sfu

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func TestCapturePullMissingPublicationKeepsNegotiation(t *testing.T) {
	track := captureTrack("publisher", "microphone", 6, captureplane.TrackSourceMicrophone, captureplane.TrackKindAudio, captureplane.TrackLayerAuto)
	for _, test := range []struct {
		name  string
		owner string
		offer bool
	}{
		{name: "missing publication with offer", owner: "publisher", offer: true},
		{name: "missing publication without optional owner"},
		{name: "missing publication without optional owner with offer", offer: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := captureTracksResponse{Tracks: []captureTrackResult{{
				providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: test.owner},
				TrackName:                  "microphone", ErrorCode: "not_found_track_error",
			}}}
			if test.offer {
				response.Description = &providerDescription{Type: "offer", SDP: "v=0\r\n"}
				response.RequiresImmediateRenegotiation = true
			}
			client := &captureSequenceClient{responses: []captureHTTPResponse{{status: http.StatusOK, body: mustCaptureJSON(t, response)}}}
			adapter := newCaptureTestAdapter(t, client)
			input := captureplane.PullCaptureTracksInput{Metadata: captureMetadata(test.name), Connection: "receiver", Tracks: []captureplane.CaptureTrack{track}}
			result, err := adapter.PullCaptureTracks(context.Background(), input)
			if err != nil || len(result.Gone) != 1 || result.Gone[0] != track || len(result.Tracks) != 0 {
				t.Fatalf("missing publication must leave capture running: result=%+v err=%v", result, err)
			}
			if test.offer && result.Negotiation.Requirement != captureplane.NegotiationAnswerNeeded {
				t.Fatalf("lost provider negotiation: %+v", result.Negotiation)
			}
			if _, err := adapter.PullCaptureTracks(context.Background(), input); err != nil || len(client.requests) != 1 {
				t.Fatalf("replayed a missing publication: requests=%d err=%v", len(client.requests), err)
			}
		})
	}
}

func TestCapturePullMixedMissingPublicationDoesNotReplaySuccess(t *testing.T) {
	requested := []captureplane.CaptureTrack{
		captureTrack("publisher", "camera", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerAuto),
		captureTrack("publisher", "microphone", 6, captureplane.TrackSourceMicrophone, captureplane.TrackKindAudio, captureplane.TrackLayerAuto),
	}
	response := captureTracksResponse{
		providerDescriptionEnvelope:    providerDescriptionEnvelope{Description: &providerDescription{Type: "offer", SDP: "v=0\r\n"}},
		RequiresImmediateRenegotiation: true,
		Tracks: []captureTrackResult{
			{TrackName: "microphone", ErrorCode: "not_found_track_error"},
			{providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: "publisher"}, TrackName: "camera", Mid: "0"},
		},
	}
	client := &captureSequenceClient{responses: []captureHTTPResponse{{status: http.StatusOK, body: mustCaptureJSON(t, response)}}}
	adapter := newCaptureTestAdapter(t, client)
	input := captureplane.PullCaptureTracksInput{Metadata: captureMetadata("mixed-missing"), Connection: "receiver", Tracks: requested}
	result, err := adapter.PullCaptureTracks(context.Background(), input)
	if err != nil || len(result.Tracks) != 1 || result.Tracks[0].CaptureTrack != requested[0] || len(result.Gone) != 1 || result.Gone[0] != requested[1] {
		t.Fatalf("partial subscription lost: result=%+v err=%v", result, err)
	}
	if _, err := adapter.PullCaptureTracks(context.Background(), input); err != nil || len(client.requests) != 1 {
		t.Fatalf("replayed a successful subscription: requests=%d err=%v", len(client.requests), err)
	}
}

func TestCapturePullMixedAnonymousMissingPublication(t *testing.T) {
	// This is a documented shape, not a retained production response:
	// https://developers.cloudflare.com/realtime/static/realtime-api-2024-05-21.yaml
	payload, err := os.ReadFile("testdata/capture-mixed-missing-identity.json")
	if err != nil {
		t.Fatal(err)
	}
	requested := []captureplane.CaptureTrack{
		captureTrack("publisher", "camera", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerAuto),
		captureTrack("publisher", "microphone", 6, captureplane.TrackSourceMicrophone, captureplane.TrackKindAudio, captureplane.TrackLayerAuto),
	}
	client := &captureSequenceClient{responses: []captureHTTPResponse{{status: http.StatusOK, body: string(payload)}}}
	adapter := newCaptureTestAdapter(t, client)
	input := captureplane.PullCaptureTracksInput{Metadata: captureMetadata("mixed-anonymous-missing"), Connection: "receiver", Tracks: requested}
	result, err := adapter.PullCaptureTracks(context.Background(), input)
	if err != nil || len(result.Tracks) != 1 || result.Tracks[0].CaptureTrack != requested[0] || len(result.Gone) != 1 || result.Gone[0] != requested[1] || result.Negotiation.Requirement != captureplane.NegotiationAnswerNeeded {
		t.Fatalf("anonymous missing track discarded partial success: result=%+v err=%v", result, err)
	}
	if _, err := adapter.PullCaptureTracks(context.Background(), input); err != nil || len(client.requests) != 1 {
		t.Fatalf("replayed a successful subscription: requests=%d err=%v", len(client.requests), err)
	}
}

func TestCapturePullMissingPublicationRejectsAmbiguousAndFatal(t *testing.T) {
	requested := []captureplane.CaptureTrack{
		captureTrack("publisher", "camera", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerAuto),
		captureTrack("publisher", "microphone", 6, captureplane.TrackSourceMicrophone, captureplane.TrackKindAudio, captureplane.TrackLayerAuto),
	}
	for _, test := range []struct {
		name   string
		tracks []captureTrackResult
	}{
		{name: "ambiguous", tracks: []captureTrackResult{{ErrorCode: "not_found_track_error"}, {ErrorCode: "not_found_track_error"}}},
		{name: "fatal after missing", tracks: []captureTrackResult{{ErrorCode: "not_found_track_error"}, {providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: "publisher"}, TrackName: "camera", ErrorCode: "internal_error"}}},
		{name: "fatal before missing", tracks: []captureTrackResult{{providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: "publisher"}, TrackName: "camera", ErrorCode: "internal_error"}, {ErrorCode: "not_found_track_error"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &captureSequenceClient{responses: []captureHTTPResponse{{status: http.StatusOK, body: mustCaptureJSON(t, captureTracksResponse{Tracks: test.tracks})}}}
			_, err := newCaptureTestAdapter(t, client).PullCaptureTracks(context.Background(), captureplane.PullCaptureTracksInput{Metadata: captureMetadata(test.name), Connection: "receiver", Tracks: requested})
			if err == nil {
				t.Fatal("ambiguous or fatal response was accepted")
			}
		})
	}
}
