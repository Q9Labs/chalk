package media

import (
	"errors"
	"runtime"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// freeAuthority is the authority of a source no control has named on a node that
// does not require grants. Unit tests that build a publication without a node use it.
func freeAuthority() *sourceAuthority {
	authority := &sourceAuthority{}
	authority.window.Store(openWindow)
	return authority
}

func control(participant, source, action string, revision int64) protocol.SourceControlRequest {
	return protocol.SourceControlRequest{TenantID: "tenant-1", EpisodeID: "episode-1", Controls: []protocol.SourceControl{
		{ParticipantID: participant, Source: source, Action: action, Revision: revision},
	}}
}

func apply(t *testing.T, n *Node, request protocol.SourceControlRequest) protocol.SourceControlResult {
	t.Helper()
	response, err := n.ControlSources(request)
	if err != nil {
		t.Fatalf("control sources: %v", err)
	}
	return response.Results[0]
}

func leaseNode(t *testing.T, lease time.Duration, require bool) *Node {
	return newTestNode(t, func(cfg *config.Config) {
		cfg.SourceLeaseTTL = lease
		cfg.RequireSourceGrant = require
	})
}

// The model's duplicate, delayed and stale commands: only a control at or above the
// recorded revision applies, and a revoke wins a tie, so nothing older undoes a revoke.
func TestSourceControlsApplyInRevisionOrder(t *testing.T) {
	n := leaseNode(t, time.Minute, true)
	scope := testScope("alice", 1)
	n.newTestSession(t, scope)
	authority, _ := n.authorityFor(scope, "microphone")
	now := func() bool { return authority.allows(monotonic(), monotonic()) }
	if now() {
		t.Fatal("a source forwards before any grant")
	}
	steps := []struct {
		action   string
		revision int64
		applied  bool
		forwards bool
	}{
		{protocol.SourceGrant, 5, true, true},
		{protocol.SourceRevoke, 4, false, true}, // delayed revoke older than the grant
		{protocol.SourceGrant, 5, true, true},   // duplicate grant: a lease renewal
		{protocol.SourceRevoke, 5, true, false}, // revoke at the grant's revision wins the tie
		{protocol.SourceGrant, 5, false, false}, // stale renewal after the revoke
		{protocol.SourceRevoke, 5, true, false}, // duplicate revoke
		{protocol.SourceGrant, 3, false, false}, // delayed enable from before the revoke
		{protocol.SourceGrant, 6, true, true},   // a newer grant alone clears the revoke
	}
	for index, step := range steps {
		before := monotonic()
		result := apply(t, n, control("alice", "microphone", step.action, step.revision))
		// A grant after a revoke opens a new window, so nothing held from the revoked time is resent.
		if step.applied && step.action == protocol.SourceGrant && index > 0 && !steps[index-1].forwards && authority.window.Load().since < before {
			t.Fatalf("step %d: the grant after a revoke kept the old window", index)
		}
		if result.Applied != step.applied || now() != step.forwards {
			t.Fatalf("step %d %s@%d: applied %v forwards %v, want %v %v", index, step.action, step.revision, result.Applied, now(), step.applied, step.forwards)
		}
	}
	if result := apply(t, n, control("alice", "camera", protocol.SourceGrant, 1)); !result.Applied {
		t.Fatal("one source's revision fenced another source")
	}
}

// Off with no publication: a revoke for a source that has no track, or no session at
// all, still stops a publication that arrives later.
func TestARevokeWithoutAPublicationFencesALaterOne(t *testing.T) {
	n := leaseNode(t, time.Minute, false)
	if result := apply(t, n, control("dave", "camera", protocol.SourceRevoke, 7)); !result.Applied || len(result.Closed) != 0 {
		t.Fatalf("revoke with no session: %+v", result)
	}
	scope := testScope("dave", 1)
	n.newTestSession(t, scope)
	authority, _ := n.authorityFor(scope, "camera")
	if authority.allows(monotonic(), monotonic()) {
		t.Fatal("a publication after the revoke forwards")
	}
	if result := apply(t, n, control("dave", "camera", protocol.SourceGrant, 6)); result.Applied {
		t.Fatal("a delayed grant undid the revoke")
	}
	if microphone, _ := n.authorityFor(scope, "microphone"); !microphone.allows(monotonic(), monotonic()) {
		t.Fatal("a source no control named stopped forwarding on a node that does not require grants")
	}
}

// Forwarding checks the lease on every packet, so a lapsed lease stops media without a ticker.
func TestALeaseLapsesWithoutRenewal(t *testing.T) {
	n := leaseNode(t, 150*time.Millisecond, true)
	scope := testScope("alice", 1)
	n.newTestSession(t, scope)
	authority, _ := n.authorityFor(scope, "microphone")
	result := apply(t, n, control("alice", "microphone", protocol.SourceGrant, 1))
	if !authority.allows(monotonic(), monotonic()) || result.LeaseMillis <= 0 || result.LeaseMillis > 150 {
		t.Fatalf("grant: %+v", result)
	}
	time.Sleep(100 * time.Millisecond)
	apply(t, n, control("alice", "microphone", protocol.SourceGrant, 1))
	time.Sleep(100 * time.Millisecond)
	if !authority.allows(monotonic(), monotonic()) {
		t.Fatal("a renewed lease lapsed at the first grant's expiry")
	}
	time.Sleep(200 * time.Millisecond)
	if authority.allows(monotonic(), monotonic()) {
		t.Fatal("a lease forwards past its expiry without renewal")
	}
}

// The table of source controls is bounded, and a full table of live sessions' sources
// refuses a new control instead of forgetting a live revoke.
func TestTheSourceTableNeverEvictsALiveSessionsSource(t *testing.T) {
	n := leaseNode(t, time.Minute, true)
	n.sourceLimit = 2
	alice := testScope("alice", 1)
	n.newTestSession(t, alice)
	apply(t, n, control("alice", "microphone", protocol.SourceRevoke, 1))
	apply(t, n, control("alice", "camera", protocol.SourceRevoke, 1))
	_, err := n.ControlSources(control("bob", "camera", protocol.SourceGrant, 2))
	if !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a full table of live sources admitted a control: %v", err)
	}
	if microphone, _ := n.authorityFor(alice, "microphone"); microphone.allows(monotonic(), monotonic()) {
		t.Fatal("the live revoke was forgotten")
	}

	n.sourceLimit = 3
	apply(t, n, control("carol", "camera", protocol.SourceRevoke, 1)) // carol has no session
	if result := apply(t, n, control("bob", "camera", protocol.SourceGrant, 2)); !result.Applied {
		t.Fatal("an entry without a live session was not evicted for a new control")
	}
	if n.sources[sourceKey{keyOf(testScope("carol", 1)), "camera"}] != nil {
		t.Fatal("the entry without a live session was kept")
	}
}

// A packet that arrived while its source was revoked is never sent later, not as live
// media and not as a retransmission after a new grant. A packet from before the revoke
// is not resent in the new window either.
func TestAPacketFromOutsideTheWindowIsNeverSent(t *testing.T) {
	pub, layers, _ := benchPublication(t)
	authority := &sourceAuthority{}
	authority.window.Store(openWindow)
	pub.authority = authority
	viewer := (*pub.subscribers.Load())[0]
	recorder := &recordingWriter{}
	viewer.track.binding.Store(&egressBinding{writer: recorder, ssrc: 100, payloadType: 96})
	packets := cameraPackets("h")
	var header rtp.Header
	writer := &packetWriter{}
	next := 0
	send := func(count int) int {
		sent := len(recorder.sequences)
		for range count {
			stamp(packets[next%len(packets)], next)
			pub.forward(layers[0], packets[next%len(packets)], &header, writer)
			next++
		}
		return len(recorder.sequences) - sent
	}
	nack := func(sequences ...uint16) int {
		sent := len(recorder.sequences)
		viewer.retransmit(&rtcp.TransportLayerNack{Nacks: rtcp.NackPairsFromSequenceNumbers(sequences)}, 64, writer)
		return len(recorder.sequences) - sent
	}
	// A retransmission that misses asks for a keyframe; the test publication has no peer to ask.
	layers[0].lastAsked.Store(monotonic() + int64(time.Hour))

	if got := send(2 * benchPacketsPerFrame); got != 2*benchPacketsPerFrame {
		t.Fatalf("an authorized source forwarded %d of %d packets", got, 2*benchPacketsPerFrame)
	}
	beforeRevoke := recorder.sequences[len(recorder.sequences)-1]

	authority.window.Store(closedWindow)
	if got := send(2 * benchPacketsPerFrame); got != 0 {
		t.Fatalf("a revoked source forwarded %d packets", got)
	}
	if got := nack(beforeRevoke); got != 0 {
		t.Fatalf("a revoked source resent %d packets", got)
	}

	now := monotonic()
	authority.window.Store(&leaseWindow{since: now, until: now + int64(time.Minute)})
	if got := send(benchPacketsPerFrame); got != benchPacketsPerFrame {
		t.Fatalf("a regranted source forwarded %d of %d packets", got, benchPacketsPerFrame)
	}
	afterGrant := recorder.sequences[len(recorder.sequences)-benchPacketsPerFrame]
	var gap []uint16
	for sequence := beforeRevoke + 1; sequence != afterGrant; sequence++ {
		gap = append(gap, sequence)
	}
	if len(gap) == 0 {
		t.Fatal("the translator hid the revoked packets' sequence numbers, so the test proves nothing")
	}
	if got := nack(gap...); got != 0 {
		t.Fatalf("%d packets from the revoked time were resent after the new grant", got)
	}
	if got := nack(beforeRevoke); got != 0 {
		t.Fatal("a packet from before the revoke was resent in the new window")
	}
	if got := nack(afterGrant); got != 1 {
		t.Fatalf("a packet of the new window was resent %d times, want 1", got)
	}
}

// A delayed revoke closes only what was published under the revision it revokes. Here
// revoke@2 waits for the session's mutex while grant@3 applies and a push publishes
// the source again; the revoke's cleanup must leave that publication open.
func TestADelayedRevokeNeverClosesAPublicationOfANewerGrant(t *testing.T) {
	n := leaseNode(t, time.Minute, true)
	scope := testScope("alice", 1)
	session := n.newTestSession(t, scope)
	apply(t, n, control("alice", "microphone", protocol.SourceGrant, 1))
	key := sourceKey{keyOf(scope), "microphone"}
	reach := func(revision int64) {
		for {
			n.mu.Lock()
			reached := n.sources[key].revision == revision
			n.mu.Unlock()
			if reached {
				return
			}
			runtime.Gosched()
		}
	}
	controlInBackground := func(action string, revision int64) chan protocol.SourceControlResponse {
		done := make(chan protocol.SourceControlResponse, 1)
		go func() {
			response, _ := n.ControlSources(control("alice", "microphone", action, revision))
			done <- response
		}()
		return done
	}

	session.mu.Lock() // the revoke's cleanup and the grant's keyframe request wait here
	revoked := controlInBackground(protocol.SourceRevoke, 2)
	reach(2)
	granted := controlInBackground(protocol.SourceGrant, 3)
	reach(3)
	pub := newPublication(session, protocol.Track{Mid: "0", TrackName: "mic", Source: "microphone"}, webrtc.RTPCodecTypeAudio)
	session.published["0"] = pub
	session.mu.Unlock()

	revoke, grant := <-revoked, <-granted
	if len(revoke.Results) != 1 || !revoke.Results[0].Applied || len(grant.Results) != 1 || !grant.Results[0].Applied {
		t.Fatalf("controls did not apply: revoke %+v, grant %+v", revoke, grant)
	}
	if closed := revoke.Results[0].Closed; len(closed) != 0 || pub.closed.Load() || session.published["0"] != pub {
		t.Fatalf("the revoke@2 cleanup closed a publication admitted under grant@3: %+v", closed)
	}
}
