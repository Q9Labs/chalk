package sfu

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func TestCapturePullRetainsSanitizedMissingTrackResponse(t *testing.T) {
	for _, trackCount := range []int{2, 100} {
		t.Run(fmt.Sprint(trackCount), func(t *testing.T) {
			tracks := []string{`{"errorCode":"not_found_track_error"}`}
			for i := 1; i < trackCount; i++ {
				tracks = append(tracks, fmt.Sprintf(`{"sessionId":"private-publisher","trackName":"private-camera-%d","mid":"%d","errorDescription":"session private-publisher not found","token":"private-token"}`, i, i))
			}
			payload := `{"tracks":[` + strings.Join(tracks, ",") + `],"requiresImmediateRenegotiation":true,"sessionDescription":{"type":"offer","sdp":"private-sdp"},"secret":"private-secret"}`
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, payload) }))
			defer provider.Close()
			adapter := addTracksRecordAdapter(t, provider.URL, time.Second)
			logs := captureAddTracksLogs(t)
			_, _ = adapter.PullCaptureTracks(context.Background(), captureplane.PullCaptureTracksInput{
				Metadata: captureMetadata("response-evidence"), Connection: "receiver",
				Tracks: []captureplane.CaptureTrack{captureTrack("private-publisher", "private-camera-1", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerAuto)},
			})
			var snapshot string
			for line := range strings.Lines(logs.String()) {
				var record struct {
					Event    string `json:"event"`
					Snapshot string `json:"provider_response_snapshot"`
				}
				if err := json.Unmarshal([]byte(line), &record); err != nil {
					t.Fatal(err)
				}
				if record.Event == "cloudflare_sfu.request_failed" {
					snapshot = record.Snapshot
				}
			}
			if snapshot == "" || len(snapshot) > 4096 || !json.Valid([]byte(snapshot)) {
				t.Fatalf("missing bounded response evidence: bytes=%d valid_json=%v", len(snapshot), json.Valid([]byte(snapshot)))
			}
			for _, secret := range []string{"private-publisher", "private-camera", "private-token", "private-sdp", "private-secret"} {
				if strings.Contains(logs.String(), secret) {
					t.Fatalf("provider evidence leaked %s", secret)
				}
			}
			var response struct {
				Tracks        []map[string]json.RawMessage `json:"tracks"`
				OmittedTracks int                          `json:"omittedTracks"`
				Description   struct {
					Type string `json:"type"`
					SDP  string `json:"sdp"`
				} `json:"sessionDescription"`
			}
			if err := json.Unmarshal([]byte(snapshot), &response); err != nil {
				t.Fatal(err)
			}
			if len(response.Tracks) == 0 || response.Tracks[0]["sessionId"] != nil || response.Tracks[0]["trackName"] != nil || string(response.Tracks[0]["errorCode"]) != `"not_found_track_error"` || response.Description.Type != "offer" || response.Description.SDP != "[redacted]" {
				t.Fatalf("response evidence lost the missing identity or negotiation shape: %s", snapshot)
			}
			if len(response.Tracks)+response.OmittedTracks != trackCount {
				t.Fatalf("lost truncation count: %+v", response)
			}
		})
	}
}
