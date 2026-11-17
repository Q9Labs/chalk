package media

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func closedEvent(t *testing.T, trail *trailLog) map[string]string {
	t.Helper()
	closed := trail.events(EventSessionClosed)
	if len(closed) != 1 {
		t.Fatalf("session.closed lines = %d, want 1: %v", len(closed), closed)
	}
	return closed[0]
}

// A session that closes without a media path says so, whatever closed it, and the first trigger
// stays in its own field.
func TestClosedSessionThatNeverConnectedSaysSo(t *testing.T) {
	for _, cause := range []string{CloseEpisodeEnded, CloseRemoved, CloseReplaced, CloseNeverConnected, ClosePeerFailed, CloseNodeShutdown} {
		t.Run(cause, func(t *testing.T) {
			trail := &trailLog{}
			node := newLoggedTestNode(t, nil, trail)
			session := node.newTestSession(t, testScope("alice", 1))
			session.CloseFor(cause)
			closed := closedEvent(t, trail)
			if closed["outcome"] != OutcomeNeverConnected || closed["connected"] != "false" || closed["cause"] != cause {
				t.Fatalf("outcome %q connected %q cause %q, want never_connected false %s", closed["outcome"], closed["connected"], closed["cause"], cause)
			}
			if _, has := closed["connect_ms"]; has {
				t.Fatalf("a session that never connected has a connect time: %v", closed)
			}
		})
	}
}

func TestConnectTimeoutClosesAsNeverConnected(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, func(cfg *config.Config) { cfg.ConnectTimeout = 20 * time.Millisecond }, trail)
	node.newTestSession(t, testScope("alice", 1))
	eventually(t, "the connect timer closes the session", 2*time.Second, func() bool { return len(trail.events(EventSessionClosed)) == 1 })
	closed := closedEvent(t, trail)
	if closed["cause"] != CloseNeverConnected || closed["outcome"] != OutcomeNeverConnected || closed["level"] != "" && closed["level"] != "WARN" {
		t.Fatalf("session.closed = %v", closed)
	}
}

// A clean leave reads as a leave. A close while the connection is down, or after ICE failed, reads
// as a drop. A recovery carries the length of the outage it ends.
func TestOutcomeSeparatesALeaveFromADropAndPairsARecovery(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	left := node.newTestSession(t, testScope("alice", 1))
	left.onConnectionState(webrtc.PeerConnectionStateConnected)
	left.CloseFor(ClosePeerClosed)

	dropped := node.newTestSession(t, testScope("bob", 1))
	dropped.onConnectionState(webrtc.PeerConnectionStateConnected)
	dropped.onConnectionState(webrtc.PeerConnectionStateDisconnected)
	time.Sleep(5 * time.Millisecond)
	dropped.onConnectionState(webrtc.PeerConnectionStateConnected)
	dropped.onConnectionState(webrtc.PeerConnectionStateDisconnected)
	dropped.CloseFor(ClosePeerClosed)

	var leave, drop map[string]string
	for _, closed := range trail.events(EventSessionClosed) {
		switch closed["participant_id"] {
		case "alice":
			leave = closed
		case "bob":
			drop = closed
		}
	}
	if leave["outcome"] != OutcomeLeft || leave["connected"] != "true" || leave["disconnects"] != "0" || leave["connect_ms"] == "" {
		t.Fatalf("a clean leave = %v", leave)
	}
	if drop["outcome"] != OutcomeDropped || drop["disconnects"] != "2" || drop["cause"] != ClosePeerClosed {
		t.Fatalf("a close while down = %v", drop)
	}

	var connects []map[string]string
	for _, state := range trail.events(EventPeerState) {
		if state["participant_id"] == "bob" && state["state"] == "connected" {
			connects = append(connects, state)
		}
	}
	if len(connects) != 2 || connects[0]["connect_ms"] == "" || connects[0]["outage_ms"] != "" || connects[1]["outage_ms"] == "" || connects[1]["connect_ms"] != "" {
		t.Fatalf("the first connected carries the connect time and the recovery carries the outage: %v", connects)
	}
}

func TestOutcomeOfEachCause(t *testing.T) {
	up, down := connectivity{Connected: true}, connectivity{Connected: true, StillDown: true}
	for _, test := range []struct {
		cause string
		link  connectivity
		want  string
	}{
		{CloseRemoved, up, OutcomeEnded}, {CloseReplaced, up, OutcomeEnded}, {CloseEpisodeEnded, up, OutcomeEnded},
		{CloseRetired, up, OutcomeEnded}, {CloseUnspecified, up, OutcomeEnded},
		{CloseNodeShutdown, up, OutcomeInterrupted}, {CloseNegotiationFailed, up, OutcomeFailed},
		{ClosePeerFailed, up, OutcomeDropped}, {ClosePeerClosed, up, OutcomeLeft}, {ClosePeerClosed, down, OutcomeDropped},
		{CloseEpisodeEnded, connectivity{}, OutcomeNeverConnected}, {CloseNegotiationFailed, connectivity{}, OutcomeNeverConnected},
	} {
		if got := outcomeOf(test.cause, test.link); got != test.want {
			t.Errorf("%s with %+v = %s, want %s", test.cause, test.link, got, test.want)
		}
	}
}

// The journal keeps the error text of a failed negotiation. The trail names the step and a reason
// from a closed set, and carries the request's trace.
func TestNegotiationFailureReachesTheTrailWithoutItsErrorText(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	session := node.newTestSession(t, testScope("alice", 1))
	session.Note(Trace{TraceID: "0af7651916cd43dd8448eb211c80319c"})
	err := session.failNegotiation(stepApplyOffer, errors.New("v=0 o=- 1 1 IN IP4 203.0.113.9"))
	if !errors.Is(err, ErrNegotiationFailed) || !strings.Contains(err.Error(), "apply the offer") {
		t.Fatalf("the caller's error changed: %v", err)
	}
	failed := trail.events(EventNegotiationFailed)
	if len(failed) != 1 || failed[0]["step"] != "apply_offer" || failed[0]["reason"] != "rejected" || failed[0]["trace_id"] != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("negotiation.failed = %v", failed)
	}
	requireIDs(t, failed[0], session.scope)
	for _, field := range EventFields[EventNegotiationFailed] {
		if field == "error" {
			t.Fatal("the negotiation event exports an error field")
		}
	}
	if closed := closedEvent(t, trail); closed["cause"] != CloseNegotiationFailed || closed["outcome"] != OutcomeNeverConnected {
		t.Fatalf("session.closed = %v", closed)
	}
	for cause, want := range map[error]string{context.DeadlineExceeded: "timeout", errGatherTimeout: "timeout", context.Canceled: "canceled", errors.New("x"): "rejected"} {
		if got := negotiationReason(cause); got != want {
			t.Errorf("negotiationReason(%v) = %s, want %s", cause, got, want)
		}
	}
}

// Node-level events carry the incarnation, and an Episode-level one names no Participant.
func TestNodeEventsCarryTheIncarnationAndEpisodeEventsNameNoParticipant(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, func(cfg *config.Config) { cfg.MaxSessions = 1 }, trail)
	node.newTestSession(t, testScope("alice", 1))
	if _, err := node.Create(op(), testScope("bob", 2), ParticipantSession, nil); err == nil {
		t.Fatal("the second session fit under a limit of one")
	}
	refused := trail.events(EventAdmissionRefused)
	if len(refused) != 1 || refused[0]["node_incarnation"] != node.Incarnation() {
		t.Fatalf("admission.refused = %v", refused)
	}

	node.refuseEpisode(episodeKey{"tenant", "episode-9"}, RefusedHolds, nil)
	episode := trail.events(EventAdmissionRefused)[1]
	if episode["tenant_id"] != "tenant" || episode["episode_id"] != "episode-9" || episode["node_incarnation"] != node.Incarnation() {
		t.Fatalf("an Episode refusal = %v", episode)
	}
	if _, has := episode["participant_id"]; has {
		t.Fatalf("an Episode refusal names a Participant: %v", episode)
	}
}

// Ending an Episode carries the request's trace onto the close lines.
func TestEndEpisodeCloseLinesCarryTheRequestsTrace(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	node.newTestSession(t, testScope("alice", 1))
	node.EndEpisode("tenant-1", "episode-1", Trace{TraceID: "0af7651916cd43dd8448eb211c80319c", JourneyID: "4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11"})
	closed := closedEvent(t, trail)
	if closed["cause"] != CloseEpisodeEnded || closed["trace_id"] != "0af7651916cd43dd8448eb211c80319c" || closed["journey_id"] == "" {
		t.Fatalf("session.closed = %v", closed)
	}
}

func TestControlFailureNamesTheOperationAndKeepsBadIdsOut(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	scope := testScope("alice", 1)
	node.ControlFailed(scope, "conn-1", "add_tracks", 422, protocol.CodeNegotiationFailed, Trace{TraceID: "0af7651916cd43dd8448eb211c80319c"}, errors.New("sdp text"))
	node.ControlFailed(protocol.Scope{TenantID: "bad id!", EpisodeID: "episode", ParticipantID: "alice", Generation: 1}, "", "inspect", 404, protocol.CodeSessionGone, Trace{}, nil)
	failed := trail.events(EventControlFailed)
	if len(failed) != 2 {
		t.Fatalf("control.failed lines = %v", failed)
	}
	requireIDs(t, failed[0], scope)
	if failed[0]["operation"] != "add_tracks" || failed[0]["status"] != "422" || failed[0]["code"] != protocol.CodeNegotiationFailed || failed[0]["connection_id"] != "conn-1" || failed[0]["trace_id"] == "" {
		t.Fatalf("control.failed = %v", failed[0])
	}
	if _, has := failed[1]["tenant_id"]; has {
		t.Fatalf("an invalid scope was logged as ids: %v", failed[1])
	}
}

// The end of an Episode reports how each Participant session ended, the ones that ended earlier
// too, and a repeat reports the same.
func TestEndEpisodeReportsEachParticipantSessionOutcome(t *testing.T) {
	node := newLoggedTestNode(t, nil, &trailLog{})
	left := node.newTestSession(t, testScope("alice", 1))
	left.onConnectionState(webrtc.PeerConnectionStateConnected)
	left.CloseFor(ClosePeerClosed)
	node.newTestSession(t, testScope("bob", 2)) // still open, never connected
	other := node.newTestSession(t, protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-2", ParticipantID: "carol", Generation: 1})
	other.CloseFor(CloseRemoved)

	response := node.EndEpisode("tenant-1", "episode-1", Trace{})
	if response.Closed != 1 || len(response.Sessions) != 2 {
		t.Fatalf("end = closed %d, %d outcomes; want 1 and 2", response.Closed, len(response.Sessions))
	}
	alice, bob := response.Sessions[0], response.Sessions[1]
	if alice.ParticipantID != "alice" || alice.Generation != 1 || alice.Outcome != OutcomeLeft || alice.Cause != ClosePeerClosed || !alice.Connected || alice.SessionID != left.id {
		t.Fatalf("alice = %+v", alice)
	}
	if bob.ParticipantID != "bob" || bob.Generation != 2 || bob.Outcome != OutcomeNeverConnected || bob.Cause != CloseEpisodeEnded || bob.Connected {
		t.Fatalf("bob = %+v", bob)
	}
	if again := node.EndEpisode("tenant-1", "episode-1", Trace{}); again.Closed != 0 || len(again.Sessions) != 2 {
		t.Fatalf("a repeated end = closed %d, %d outcomes; want 0 and 2", again.Closed, len(again.Sessions))
	}
	if unrelated := node.EndEpisode("tenant-1", "episode-9", Trace{}); len(unrelated.Sessions) != 0 {
		t.Fatalf("an Episode with no sessions reported %v", unrelated.Sessions)
	}
}

// A session that was already closing when the Episode ended records its outcome after it leaves
// the Episode's list, and the end waits for it.
func TestEndEpisodeWaitsForClosesAlreadyUnderWay(t *testing.T) {
	node := newLoggedTestNode(t, nil, &trailLog{})
	leaving := node.newTestSession(t, testScope("alice", 1))
	node.remove(leaving)
	node.closing.Add(1)
	go func() {
		time.Sleep(50 * time.Millisecond)
		node.recordOutcome(leaving, ClosePeerClosed, OutcomeLeft, connectivity{Connected: true}, time.Now())
		node.closing.Add(-1)
	}()
	if response := node.EndEpisode("tenant-1", "episode-1", Trace{}); len(response.Sessions) != 1 {
		t.Fatalf("the end reported %d outcomes, want the one that was closing", len(response.Sessions))
	}
}

func TestOutcomesAreBoundedAndExpire(t *testing.T) {
	node := newLoggedTestNode(t, nil, &trailLog{})
	for generation := int64(1); generation <= outcomeSessionLimit+10; generation++ {
		node.newTestSession(t, testScope("alice", generation)).CloseFor(CloseRemoved)
	}
	if got := len(node.EndEpisode("tenant-1", "episode-1", Trace{}).Sessions); got != outcomeSessionLimit {
		t.Fatalf("held %d outcomes, want the limit %d", got, outcomeSessionLimit)
	}
	node.now = func() time.Time { return time.Now().Add(outcomeTTL + time.Minute) }
	node.newTestSession(t, protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-2", ParticipantID: "bob", Generation: 1}).CloseFor(CloseRemoved)
	if got := len(node.EndEpisode("tenant-1", "episode-1", Trace{}).Sessions); got != 0 {
		t.Fatalf("an Episode idle past the TTL still holds %d outcomes", got)
	}
}
