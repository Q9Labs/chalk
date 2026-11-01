package sfu

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const callTraceRay = "8f3c1a2b4d5e6f70-FRA"

var callTraceFields = []string{
	"time", "level", "msg", "event", "operation", "kind", "track_count", "http_status",
	"dns_ms", "connect_ms", "tls_ms", "ttfb_ms", "conn_reused", "conn_idle_ms", "ip_family", "colo",
}

// A pull logs its phase timings, the colo and the address family, and a second call on the same
// connection reports the reuse. The ray ID and the server address never reach the log.
func TestCallTraceLogsPhasesColoAndConnectionReuse(t *testing.T) {
	const answerDelay = 60 * time.Millisecond
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(answerDelay)
		w.Header().Set("Cf-Ray", callTraceRay)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tracks":[]}`))
	}))
	defer server.Close()
	adapter := addTracksRecordAdapter(t, server.URL, time.Second)
	logs := captureAddTracksLogs(t)
	pull := mediaplane.TracksRequest{ConnectionID: "listener", Tracks: []mediaplane.Track{
		{Location: "remote", SessionID: "publisher", TrackName: "a"},
		{Location: "remote", SessionID: "publisher", TrackName: "b"},
	}}
	for range 2 {
		_, _ = adapter.AddTracks(context.Background(), pull)
		time.Sleep(20 * time.Millisecond)
	}

	records := callTraceRecords(t, logs.String())
	if len(records) != 2 {
		t.Fatalf("call trace records = %d, want 2:\n%s", len(records), logs.String())
	}
	for _, record := range records {
		if got := keysOf(record); !slices.Equal(got, slices.Sorted(slices.Values(callTraceFields))) {
			t.Fatalf("record fields = %v, want exactly %v", got, callTraceFields)
		}
		if record["operation"] != "add_tracks" || record["kind"] != "pull" || record["track_count"] != float64(2) {
			t.Fatalf("operation/kind/track_count = %v/%v/%v", record["operation"], record["kind"], record["track_count"])
		}
		if record["colo"] != "FRA" || record["ip_family"] != "v4" || record["http_status"] != float64(200) {
			t.Fatalf("colo/ip_family/http_status = %v/%v/%v", record["colo"], record["ip_family"], record["http_status"])
		}
		if ttfb, _ := record["ttfb_ms"].(float64); ttfb < float64(answerDelay.Milliseconds()-10) {
			t.Fatalf("ttfb_ms = %v, want about %d", record["ttfb_ms"], answerDelay.Milliseconds())
		}
	}
	if records[0]["conn_reused"] != false || records[1]["conn_reused"] != true {
		t.Fatalf("conn_reused = %v then %v, want false then true", records[0]["conn_reused"], records[1]["conn_reused"])
	}
	if idle, _ := records[1]["conn_idle_ms"].(float64); idle < 1 {
		t.Fatalf("conn_idle_ms on the reused connection = %v, want > 0", records[1]["conn_idle_ms"])
	}
	host, _, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	for _, forbidden := range []string{"8f3c1a2b4d5e6f70", host} {
		if strings.Contains(logs.String(), forbidden) {
			t.Fatalf("log contains %q", forbidden)
		}
	}
}

// A call that gets no answer still logs, with status 0 and no first byte.
func TestCallTraceLogsACallWithoutAnAnswer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		// The server notices a dropped connection only after the request body is read.
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}))
	defer server.Close()
	adapter := addTracksRecordAdapter(t, server.URL, 100*time.Millisecond)
	logs := captureAddTracksLogs(t)

	_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{ConnectionID: "publisher", Tracks: []mediaplane.Track{{Location: "local", Mid: "0", TrackName: "a"}}})
	if err == nil {
		t.Fatal("want a timeout error")
	}
	records := callTraceRecords(t, logs.String())
	if len(records) != 1 || records[0]["http_status"] != float64(0) || records[0]["ttfb_ms"] != float64(0) || records[0]["kind"] != "publish" || records[0]["colo"] != "" {
		t.Fatalf("records = %v", records)
	}
}

func TestColoFromRay(t *testing.T) {
	for ray, want := range map[string]string{
		"8f3c1a2b4d5e6f70-FRA":   "FRA",
		"8f3c1a2b4d5e6f70-sin":   "SIN",
		" 8f3c1a2b4d5e6f70-DXB ": "DXB",
		"8f3c1a2b4d5e6f70":       "",
		"8f3c1a2b4d5e6f70-":      "",
		"8f3c1a2b4d5e6f70-FRAX":  "",
		"":                       "",
	} {
		if got := coloFromRay(ray); got != want {
			t.Errorf("coloFromRay(%q) = %q, want %q", ray, got, want)
		}
	}
}

func TestAddressFamily(t *testing.T) {
	for address, want := range map[string]string{"203.0.113.7:443": "v4", "[2001:db8::1]:443": "v6"} {
		resolved, err := net.ResolveTCPAddr("tcp", address)
		if err != nil {
			t.Fatal(err)
		}
		if got := addressFamily(resolved); got != want {
			t.Errorf("addressFamily(%s) = %q, want %q", address, got, want)
		}
	}
}

func callTraceRecords(t *testing.T, logs string) []map[string]any {
	t.Helper()
	var records []map[string]any
	for line := range strings.Lines(logs) {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log line %q: %v", line, err)
		}
		if record["event"] == "cloudflare_sfu.call_trace" {
			records = append(records, record)
		}
	}
	return records
}

func keysOf(record map[string]any) []string {
	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
