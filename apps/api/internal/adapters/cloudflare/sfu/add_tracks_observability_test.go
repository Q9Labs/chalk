package sfu

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	addTracksTestSecret       = "app-secret-must-not-leak"
	addTracksTestSDP          = "v=0\r\no=- 4611731400430051336 2 IN IP4 203.0.113.7\r\na=ice-pwd:ice-password-must-not-leak\r\na=rid:h send\r\na=rid:l send\r\na=simulcast:send h;l\r\n"
	addTracksTestRemoteSource = "remote-sender-session"
)

var addTracksRecordFields = []string{
	"time", "level", "msg", "event",
	"space_id", "episode_id", "provider_session_id",
	"track_count", "track_kinds", "sdp_type", "sdp_rid_count", "simulcast_track_count",
	"upstream_latency_ms", "outcome", "http_status", "provider_code", "retry",
}

func TestAddTracksRecordsUpstreamTimeout(t *testing.T) {
	release := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-release
	}))
	defer provider.Close()
	defer close(release)
	adapter := addTracksRecordAdapter(t, provider.URL, 150*time.Millisecond)
	logs := captureAddTracksLogs(t)

	_, err := adapter.AddTracks(context.Background(), addTracksRecordRequest())
	if err == nil {
		t.Fatal("hanging provider must fail add tracks")
	}

	record := addTracksRecord(t, logs)
	assertAddTracksRequestFields(t, record)
	if record["level"] != "WARN" || record["outcome"] != "transport" || record["provider_code"] != "timeout" || record["http_status"] != float64(0) {
		t.Fatalf("timeout outcome = level %v outcome %v provider_code %v http_status %v", record["level"], record["outcome"], record["provider_code"], record["http_status"])
	}
	if latency, _ := record["upstream_latency_ms"].(float64); latency < 150 || latency > 5000 {
		t.Fatalf("upstream_latency_ms = %v, want the 150 ms transport timeout", record["upstream_latency_ms"])
	}
	assertNoAddTracksSecrets(t, logs.String())
}

func TestAddTracksRecordsSuccessfulCall(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"sessionDescription":{"type":"answer","sdp":"answer-sdp"},"tracks":[`+
			`{"location":"local","mid":"0","trackName":"camera-track-name"},`+
			`{"location":"remote","sessionId":"`+addTracksTestRemoteSource+`","trackName":"remote-track-name","mid":"1"}]}`)
	}))
	defer provider.Close()
	adapter := addTracksRecordAdapter(t, provider.URL, time.Second)
	logs := captureAddTracksLogs(t)

	if _, err := adapter.AddTracks(context.Background(), addTracksRecordRequest()); err != nil {
		t.Fatalf("add tracks: %v", err)
	}

	record := addTracksRecord(t, logs)
	assertAddTracksRequestFields(t, record)
	if record["level"] != "INFO" || record["outcome"] != "ok" || record["provider_code"] != "" || record["http_status"] != float64(http.StatusOK) {
		t.Fatalf("success outcome = level %v outcome %v provider_code %v http_status %v", record["level"], record["outcome"], record["provider_code"], record["http_status"])
	}
	if _, ok := record["upstream_latency_ms"].(float64); !ok {
		t.Fatalf("upstream_latency_ms = %#v, want a number", record["upstream_latency_ms"])
	}
	assertNoAddTracksSecrets(t, logs.String())
}

func addTracksRecordAdapter(t *testing.T, endpoint string, timeout time.Duration) Adapter {
	t.Helper()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "test-app", RealtimeAppSecret: addTracksTestSecret, RequestTimeout: timeout,
	}, nil, endpoint)
	if err != nil {
		t.Fatalf("create adapter: %v", err)
	}
	return adapter
}

func addTracksRecordRequest() mediaplane.TracksRequest {
	return mediaplane.TracksRequest{
		ConnectionID:       "provider-session-1",
		SpaceID:            "11111111-1111-4111-8111-111111111111",
		EpisodeID:          "22222222-2222-4222-8222-222222222222",
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: addTracksTestSDP},
		Tracks: []mediaplane.Track{
			{Location: "local", Mid: "0", TrackName: "camera-track-name", Source: "camera"},
			{Location: "remote", SessionID: addTracksTestRemoteSource, TrackName: "remote-track-name", Simulcast: &mediaplane.Simulcast{PreferredRID: "h", PriorityOrdering: "asciibetical", RIDNotAvailable: "asciibetical"}},
		},
	}
}

func captureAddTracksLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &output
}

func addTracksRecord(t *testing.T, logs *bytes.Buffer) map[string]any {
	t.Helper()
	var records []map[string]any
	for line := range strings.Lines(logs.String()) {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log line %q: %v", line, err)
		}
		if record["event"] == "cloudflare_sfu.add_tracks" {
			records = append(records, record)
		}
	}
	if len(records) != 1 {
		t.Fatalf("add tracks records = %d, want 1:\n%s", len(records), logs.String())
	}
	fields := slices.Sorted(maps.Keys(records[0]))
	if want := slices.Sorted(slices.Values(addTracksRecordFields)); !slices.Equal(fields, want) {
		t.Fatalf("record fields = %v, want exactly %v", fields, want)
	}
	return records[0]
}

func assertAddTracksRequestFields(t *testing.T, record map[string]any) {
	t.Helper()
	want := map[string]any{
		"space_id":              "11111111-1111-4111-8111-111111111111",
		"episode_id":            "22222222-2222-4222-8222-222222222222",
		"provider_session_id":   "provider-session-1",
		"track_count":           float64(2),
		"sdp_type":              "offer",
		"sdp_rid_count":         float64(2),
		"simulcast_track_count": float64(1),
		"retry":                 "none",
	}
	for field, value := range want {
		if record[field] != value {
			t.Errorf("%s = %#v, want %#v", field, record[field], value)
		}
	}
	if kinds, _ := record["track_kinds"].([]any); len(kinds) != 2 || kinds[0] != "camera" || kinds[1] != "remote" {
		t.Errorf("track_kinds = %#v, want [camera remote]", record["track_kinds"])
	}
}

func assertNoAddTracksSecrets(t *testing.T, logs string) {
	t.Helper()
	for _, secret := range []string{addTracksTestSecret, "Bearer", "ice-password", "203.0.113.7", "a=rid", "v=0", "answer-sdp", "camera-track-name", "remote-track-name", addTracksTestRemoteSource} {
		if strings.Contains(logs, secret) {
			t.Fatalf("logs exposed %q:\n%s", secret, logs)
		}
	}
}
