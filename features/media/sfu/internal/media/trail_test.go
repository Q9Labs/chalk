package media

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// trailLog keeps the records a node logs, with their attributes flattened to strings.
type trailLog struct {
	mu      sync.Mutex
	records []map[string]string
}

func (l *trailLog) Enabled(context.Context, slog.Level) bool { return true }
func (l *trailLog) WithAttrs([]slog.Attr) slog.Handler       { return l }
func (l *trailLog) WithGroup(string) slog.Handler            { return l }

func (l *trailLog) Handle(_ context.Context, record slog.Record) error {
	fields := map[string]string{"msg": record.Message}
	record.Attrs(func(attr slog.Attr) bool {
		fields[attr.Key] = attr.Value.String()
		return true
	})
	l.mu.Lock()
	l.records = append(l.records, fields)
	l.mu.Unlock()
	return nil
}

// events returns the records of one event name, oldest first.
func (l *trailLog) events(name string) []map[string]string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var found []map[string]string
	for _, record := range l.records {
		if record["event"] == name {
			found = append(found, record)
		}
	}
	return found
}

func (l *trailLog) all() []map[string]string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]map[string]string(nil), l.records...)
}

func requireIDs(t *testing.T, record map[string]string, scope protocol.Scope) {
	t.Helper()
	want := map[string]string{"tenant_id": scope.TenantID, "episode_id": scope.EpisodeID, "participant_id": scope.ParticipantID, "generation": fmt.Sprint(scope.Generation)}
	for key, value := range want {
		if record[key] != value {
			t.Fatalf("%s: %s = %q, want %q (record %v)", record["event"], key, record[key], value, record)
		}
	}
}

func TestTrailExplainsOneParticipantsCall(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	alice := node.newTestSession(t, testScope("alice", 1))
	bob := node.newTestSession(t, testScope("bob", 3))
	bob.Note(Trace{TraceID: "0af7651916cd43dd8448eb211c80319c", JourneyID: "4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11"})
	publish(t, alice, "mic", 1)
	viewer := newTestPeer(t)
	pulled, err := bob.AddTracks(context.Background(), pullRequest(bob, alice, "mic-0"))
	if err != nil {
		t.Fatal(err)
	}
	if err := bob.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: bob.scope, SessionDescription: viewer.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatal(err)
	}
	bob.CloseFor(CloseRemoved)

	published := trail.events("sfu.publication.started")
	if len(published) != 1 || published[0]["source"] != "microphone" {
		t.Fatalf("publication.started = %v", published)
	}
	requireIDs(t, published[0], alice.scope)

	started := trail.events("sfu.subscription.started")
	if len(started) != 1 || started[0]["publisher_id"] != "alice" {
		t.Fatalf("subscription.started = %v", started)
	}
	requireIDs(t, started[0], bob.scope)
	if started[0]["trace_id"] != "0af7651916cd43dd8448eb211c80319c" || started[0]["journey_id"] != "4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11" {
		t.Fatalf("the subscription line lacks the request's trace: %v", started[0])
	}
	if started[0]["connection_id"] != bob.id {
		t.Fatalf("connection_id = %q, want %q", started[0]["connection_id"], bob.id)
	}

	stopped := trail.events("sfu.subscription.stopped")
	if len(stopped) != 1 || stopped[0]["reason"] != "session_closed" {
		t.Fatalf("subscription.stopped = %v", stopped)
	}

	closed := trail.events("sfu.session.closed")
	if len(closed) != 1 || closed[0]["cause"] != CloseRemoved || closed[0]["subscriptions"] != "1" {
		t.Fatalf("session.closed = %v", closed)
	}
	requireIDs(t, closed[0], bob.scope)

	// A second close changes nothing: the first cause stands.
	bob.CloseFor(ClosePeerFailed)
	if again := trail.events("sfu.session.closed"); len(again) != 1 {
		t.Fatalf("a second close logged again: %v", again)
	}
}

func TestTrailNamesThePeerStatesBeforeTheClose(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	session := node.newTestSession(t, testScope("alice", 1))
	publish(t, session, "mic", 1)
	session.CloseFor(ClosePeerFailed)
	if states := trail.events("sfu.peer.state"); len(states) == 0 {
		t.Fatal("no peer state line before the close")
	}
	if closed := trail.events("sfu.session.closed"); len(closed) != 1 || closed[0]["cause"] != ClosePeerFailed || closed[0]["msg"] != "sfu.session.closed" {
		t.Fatalf("session.closed = %v", closed)
	}
}

func TestTrailNamesARefusedJoinWithItsIds(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, func(cfg *config.Config) { cfg.MaxSessions = 1 }, trail)
	node.newTestSession(t, testScope("alice", 1))
	scope := testScope("bob", 2)
	if _, err := node.Create(op(), scope, ParticipantSession, nil); err == nil {
		t.Fatal("the second session fit under a limit of one")
	}
	refused := trail.events("sfu.admission.refused")
	if len(refused) != 1 || refused[0]["reason"] != RefusedSessions {
		t.Fatalf("admission.refused = %v", refused)
	}
	requireIDs(t, refused[0], scope)

	node.SessionRefused(scope, "", "capacity_exceeded", Trace{TraceID: "0af7651916cd43dd8448eb211c80319c"})
	line := trail.events("sfu.session.refused")
	if len(line) != 1 || line[0]["code"] != "capacity_exceeded" || line[0]["trace_id"] != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("session.refused = %v", line)
	}
	requireIDs(t, line[0], scope)
}

func TestTrailNamesALostSourceLease(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	apply(t, node, control("alice", "camera", protocol.SourceGrant, 1))
	apply(t, node, control("alice", "camera", protocol.SourceRevoke, 2))
	opened, lost := trail.events("sfu.source.lease_opened"), trail.events("sfu.source.lease_lost")
	if len(opened) != 1 || len(lost) != 1 || lost[0]["cause"] != "revoked" || lost[0]["source"] != "camera" {
		t.Fatalf("lease lines = %v, %v", opened, lost)
	}
	requireIDs(t, lost[0], protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "alice"})
}

// A line never holds SDP, an address, a candidate or a name: the trail is safe to store beside the API's logs.
func TestTrailHoldsNoSDPAddressOrSecret(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	alice := node.newTestSession(t, testScope("alice", 1))
	bob := node.newTestSession(t, testScope("bob", 1))
	publish(t, alice, "mic", 1)
	viewer := newTestPeer(t)
	pulled, err := bob.AddTracks(context.Background(), pullRequest(bob, alice, "mic-0"))
	if err != nil {
		t.Fatal(err)
	}
	if err := bob.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: bob.scope, SessionDescription: viewer.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatal(err)
	}
	bob.CloseFor(CloseRemoved)
	alice.CloseFor(CloseRemoved)
	for _, record := range trail.all() {
		for key, value := range record {
			for _, forbidden := range []string{"v=0", "a=ice", "a=fingerprint", "candidate:", "127.0.0.1", "::1", "ice-ufrag"} {
				if strings.Contains(value, forbidden) {
					t.Fatalf("%s.%s holds %q: %q", record["event"], key, forbidden, value)
				}
			}
		}
	}
}
