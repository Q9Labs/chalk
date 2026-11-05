package sfu

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// The OpenTelemetry log bridge renders a slog value only when it is a basic kind. A named string type
// arrives as an arbitrary value and logs as "unhandled: (sfu.transportCause)".
type kindRecorder struct{ kinds map[string]slog.Kind }

func (h kindRecorder) Enabled(context.Context, slog.Level) bool { return true }
func (h kindRecorder) Handle(_ context.Context, record slog.Record) error {
	record.Attrs(func(attr slog.Attr) bool {
		h.kinds[attr.Key] = attr.Value.Kind()
		return true
	})
	return nil
}
func (h kindRecorder) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h kindRecorder) WithGroup(string) slog.Handler      { return h }

func TestRequestFailedLogsItsNamedStringFieldsAsPlainStrings(t *testing.T) {
	kinds := kindRecorder{kinds: map[string]slog.Kind{}}
	previous := slog.Default()
	slog.SetDefault(slog.New(kinds))
	t.Cleanup(func() { slog.SetDefault(previous) })
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "transport-cause-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second,
	}, &http.Client{Transport: faultTransport(func(*http.Request) (*http.Response, error) { return nil, syscall.ECONNRESET })}, "https://rtc.example.test/v1")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := adapter.AddTracks(context.Background(), publishRequest("transport-cause-connection")); err == nil {
		t.Fatal("the transport failure must fail the call")
	}

	for _, field := range []string{"transport_cause", "failure_stage"} {
		if got := kinds.kinds[field]; got != slog.KindString {
			t.Errorf("%s must be logged as a string, got kind %v", field, got)
		}
	}
}

func addTracksRecords(t *testing.T, logs string) []map[string]any {
	t.Helper()
	var records []map[string]any
	for line := range strings.Lines(logs) {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log line %q: %v", line, err)
		}
		if record["event"] == "cloudflare_sfu.add_tracks" {
			records = append(records, record)
		}
	}
	return records
}

// Production timeouts at 6 s mix calls on a dead session with calls on a live one. The session's age and
// whether the connection negotiated tell them apart.
func TestAddTracksLogsTheSessionAgeAndWhetherTheConnectionNegotiated(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	clock := time.Unix(1_700_000_000, 0)
	adapter.sessions.now = func() time.Time { return clock }
	advance := func(d time.Duration) {
		fake.advance(d)
		clock = clock.Add(d)
	}
	speaker := joinParticipant(t, adapter, "speaker")
	advance(20 * time.Second)
	logs := captureAddTracksLogs(t)

	if _, err := adapter.AddTracks(context.Background(), publishRequest(speaker)); err != nil {
		t.Fatalf("first publish after 20 s idle: %v", err)
	}
	advance(3 * time.Second)
	if _, err := adapter.AddTracks(context.Background(), publishRequest(speaker)); err != nil {
		t.Fatalf("second publish: %v", err)
	}

	records := addTracksRecords(t, logs.String())
	if len(records) != 2 {
		t.Fatalf("add tracks records = %d, want 2 (the first call on its proactively swapped session, the next call):\n%s", len(records), logs.String())
	}
	want := []struct {
		age        float64
		negotiated bool
	}{
		{0, false},    // the first call, after the idle connection got a fresh session that has not negotiated yet
		{3_000, true}, // a later call on the negotiated, swapped connection, aged since the swap
	}
	for i, record := range records {
		if record["session_age_ms"] != want[i].age || record["session_negotiated"] != want[i].negotiated {
			t.Errorf("record %d: session_age_ms=%v session_negotiated=%v, want %v %v", i, record["session_age_ms"], record["session_negotiated"], want[i].age, want[i].negotiated)
		}
	}
}

// Another call can replace a session after this call chose it. The log must then describe the session the
// attempt really contacts, which is no longer the connection's current one.
func TestSessionContextDescribesTheSessionTheAttemptContacts(t *testing.T) {
	registry := newSessionRegistry()
	clock := time.Unix(1_700_000_000, 0)
	registry.now = func() time.Time { return clock }
	registry.issue("conn")
	clock = clock.Add(11 * time.Second)
	if _, replaced, err := registry.replace(context.Background(), "conn", "conn", func(context.Context) (string, error) { return "moved", nil }); err != nil || !replaced {
		t.Fatalf("setup: replace failed: replaced=%v err=%v", replaced, err)
	}
	clock = clock.Add(2 * time.Second)

	if age, negotiated := registry.sessionContext("conn", "moved"); age != 2_000 || negotiated {
		t.Errorf("current session: age=%d negotiated=%v, want 2000 false", age, negotiated)
	}
	if age, negotiated := registry.sessionContext("conn", "conn"); age != -1 || negotiated {
		t.Errorf("replaced session: age=%d negotiated=%v, want unknown (-1) and not negotiated", age, negotiated)
	}
}

// A replacement that is discarded because the connection negotiated while it was created is never
// contacted. No log line may describe it, and a later call on the connection logs the session the
// connection really uses.
func TestDiscardedReplacementSessionIsNeverLoggedAsTheOneContacted(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	clock := time.Unix(1_700_000_000, 0)
	adapter.sessions.now = func() time.Time { return clock }
	advance := func(d time.Duration) {
		fake.advance(d)
		clock = clock.Add(d)
	}
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatalf("publish: %v", err)
	}
	listener := joinParticipant(t, adapter, "listener")
	logs := captureAddTracksLogs(t)
	callArrived, releaseCall := fake.holdNextCallOn(listener)
	t.Cleanup(releaseCall)
	createArrived, releaseCreate := fake.holdNextNewSession()
	t.Cleanup(releaseCreate)
	firstDone := make(chan error, 1)
	go func() {
		_, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher))
		firstDone <- err
	}()
	waitFor := func(ch <-chan struct{}, what string) {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s never happened", what)
		}
	}
	waitFor(callArrived, "the first pull reaching Cloudflare")
	advance(20 * time.Second) // the session expires while Cloudflare holds the call, which then answers 410
	releaseCall()
	waitFor(createArrived, "the replacement create")
	fake.markConnected(listener) // the peer connects and another call negotiates on the old session
	answer := mediaplane.SessionDescription{Type: "answer", SDP: "v=0"}
	if err := adapter.Renegotiate(context.Background(), mediaplane.RenegotiateRequest{ConnectionID: listener, SessionDescription: answer}); err != nil {
		t.Fatalf("renegotiate on the connected session: %v", err)
	}
	releaseCreate()
	if err := <-firstDone; !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		t.Fatalf("the replacement must be discarded, got %v", err)
	}
	if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
		t.Fatalf("a later call on the negotiated connection: %v", err)
	}

	records := addTracksRecords(t, logs.String())
	if len(records) != 2 {
		t.Fatalf("add tracks records = %d, want 2 (the call that found the session gone, the later call):\n%s", len(records), logs.String())
	}
	if first := records[0]; first["http_status"] != float64(http.StatusGone) || first["session_age_ms"] != float64(0) || first["session_negotiated"] != false {
		t.Errorf("the first call contacted the old session when it was young and not negotiated: %v", records[0])
	}
	if later := records[1]; later["http_status"] != float64(http.StatusOK) || later["session_age_ms"] != float64(-1) || later["session_negotiated"] != true {
		t.Errorf("the later call must log the negotiated connection, not the discarded session: %v", records[1])
	}
	if age, negotiated := adapter.sessions.sessionContext(listener, "cf-3"); age != -1 || !negotiated {
		t.Errorf("a session the connection never used must not read as its current one: age=%d negotiated=%v", age, negotiated)
	}
}
