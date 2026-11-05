package media

import (
	"errors"
	"fmt"
	"math"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// openWindow lets every packet through. Unit tests that build a publication without
// a node or a grant forward under it.
var openWindow = &leaseWindow{since: math.MinInt64, until: math.MaxInt64, opens: 1}

func freeAuthority() *sourceAuthority {
	authority := &sourceAuthority{}
	authority.window.Store(openWindow)
	return authority
}

func authorityOf(t *testing.T, n *Node, scope protocol.Scope, source string) *sourceAuthority {
	t.Helper()
	authority, _, _, err := n.authorityFor(scope, source)
	if err != nil {
		t.Fatalf("admit %s: %v", source, err)
	}
	return authority
}

func admitPublication(t *testing.T, session *Session, track protocol.Track, kind webrtc.RTPCodecType) *publication {
	t.Helper()
	pub, err := newPublication(session, track, kind)
	if err != nil {
		t.Fatalf("publish %s: %v", track.TrackName, err)
	}
	return pub
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

func leaseNode(t *testing.T, lease time.Duration) *Node {
	return newTestNode(t, func(cfg *config.Config) { cfg.SourceLeaseTTL = lease })
}

// The model's duplicate, delayed and stale commands: only a control at or above the
// recorded revision applies, and a revoke wins a tie, so nothing older undoes a revoke.
func TestSourceControlsApplyInRevisionOrder(t *testing.T) {
	n := leaseNode(t, time.Minute)
	scope := testScope("alice", 1)
	n.newTestSession(t, scope)
	authority := authorityOf(t, n, scope, "microphone")
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
	n := leaseNode(t, time.Minute)
	if result := apply(t, n, control("dave", "camera", protocol.SourceRevoke, 7)); !result.Applied || len(result.Closed) != 0 {
		t.Fatalf("revoke with no session: %+v", result)
	}
	scope := testScope("dave", 1)
	n.newTestSession(t, scope)
	authority := authorityOf(t, n, scope, "camera")
	if authority.allows(monotonic(), monotonic()) {
		t.Fatal("a publication after the revoke forwards")
	}
	if result := apply(t, n, control("dave", "camera", protocol.SourceGrant, 6)); result.Applied {
		t.Fatal("a delayed grant undid the revoke")
	}
	if microphone := authorityOf(t, n, scope, "microphone"); microphone.allows(monotonic(), monotonic()) {
		t.Fatal("a source no control named forwards without a grant")
	}
}

// Forwarding checks the lease on every packet, so a lapsed lease stops media without a ticker.
func TestALeaseLapsesWithoutRenewal(t *testing.T) {
	n := leaseNode(t, 150*time.Millisecond)
	scope := testScope("alice", 1)
	n.newTestSession(t, scope)
	authority := authorityOf(t, n, scope, "microphone")
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
	n := leaseNode(t, time.Minute)
	n.sourceLimit = 2
	alice := testScope("alice", 1)
	n.newTestSession(t, alice)
	apply(t, n, control("alice", "microphone", protocol.SourceRevoke, 1))
	apply(t, n, control("alice", "camera", protocol.SourceRevoke, 1))
	_, err := n.ControlSources(control("bob", "camera", protocol.SourceGrant, 2))
	if !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a full table of live sources admitted a control: %v", err)
	}
	if microphone := authorityOf(t, n, alice, "microphone"); microphone.allows(monotonic(), monotonic()) {
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

// A revoke the full table evicts still fences its source: a delayed older grant cannot
// open it, and a later publication starts without a lease. A grant at or above the
// Episode's floor still opens it.
func TestAnEvictedRevokeStillFencesItsSource(t *testing.T) {
	n := leaseNode(t, time.Minute)
	n.sourceLimit = 1
	alice := testScope("alice", 1)
	apply(t, n, control("alice", "camera", protocol.SourceRevoke, 5)) // alice has no session
	if result := apply(t, n, control("bob", "camera", protocol.SourceGrant, 6)); !result.Applied {
		t.Fatalf("bob's grant: %+v", result)
	}
	if n.sources[sourceKey{keyOf(alice), "camera"}] != nil {
		t.Fatal("alice's revoke was not evicted")
	}

	if result := apply(t, n, control("alice", "camera", protocol.SourceGrant, 4)); result.Applied || result.LeaseMillis != 0 {
		t.Fatalf("a grant older than the evicted revoke applied: %+v", result)
	}
	session := n.newTestSession(t, alice)
	pub := admitPublication(t, session, protocol.Track{Mid: "0", TrackName: "cam", Source: "camera"}, webrtc.RTPCodecTypeVideo)
	if pub.authority.allows(monotonic(), monotonic()) {
		t.Fatal("a publication after the evicted revoke forwards")
	}

	if result := apply(t, n, control("alice", "camera", protocol.SourceGrant, 6)); !result.Applied || !pub.authority.allows(monotonic(), monotonic()) {
		t.Fatalf("a grant at the Episode's floor did not open the source: %+v", result)
	}
}

// The Episode floors share the source table's limit. Evicting into an Episode that has a
// floor costs nothing, and once the floors are full an entry that needs one stays.
func TestSourceFloorsStayBounded(t *testing.T) {
	n := leaseNode(t, time.Minute)
	n.sourceLimit = 1
	in := func(episode, participant string, revision int64) protocol.SourceControlRequest {
		request := control(participant, "camera", protocol.SourceGrant, revision)
		request.EpisodeID = episode
		return request
	}
	apply(t, n, in("episode-1", "alice", 1))
	apply(t, n, in("episode-1", "bob", 2)) // evicts alice, so episode-1 takes the only floor
	if result := apply(t, n, in("episode-2", "carol", 1)); !result.Applied {
		t.Fatalf("evicting into an Episode with a floor was refused: %+v", result)
	}
	if _, err := n.ControlSources(in("episode-3", "dave", 1)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("an eviction that needs a floor past the limit was admitted: %v", err)
	}
	if len(n.sources) != 1 || len(n.sourceFloors) != 1 {
		t.Fatalf("table holds %d sources and %d floors, limit 1", len(n.sources), len(n.sourceFloors))
	}
}

// Publication admission keeps the table at its limit when an entry can't be evicted. With
// the only floor taken, bob's revision-2 entry in a second Episode would need a new floor,
// so it stays, and each publish and close cycle must reclaim the previous cycle's entry
// or refuse instead of growing the table.
func TestPublicationAdmissionKeepsTheSourceTableBounded(t *testing.T) {
	n := leaseNode(t, time.Minute)
	n.sourceLimit = 1
	in := func(episode, participant string, revision int64) protocol.SourceControlRequest {
		request := control(participant, "camera", protocol.SourceGrant, revision)
		request.EpisodeID = episode
		return request
	}
	apply(t, n, in("episode-1", "alice", 1))
	apply(t, n, in("episode-2", "bob", 2)) // evicts alice, so episode-1 takes the only floor
	for cycle := range 40 {
		scope := testScope(fmt.Sprintf("carol-%d", cycle), 1)
		session := n.newTestSession(t, scope)
		if _, err := newPublication(session, protocol.Track{Mid: "0", TrackName: "mic", Source: "microphone"}, webrtc.RTPCodecTypeAudio); err != nil && !errors.Is(err, ErrCapacityExceeded) {
			t.Fatalf("cycle %d: %v", cycle, err)
		}
		session.Close()
	}
	if len(n.sources) > n.sourceLimit || len(n.sourceOrder) != len(n.sources) || len(n.sourceFloors) > n.sourceLimit {
		t.Fatalf("after 40 publish and close cycles the table holds %d sources, %d in order and %d floors, limit %d",
			len(n.sources), len(n.sourceOrder), len(n.sourceFloors), n.sourceLimit)
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
	n := leaseNode(t, time.Minute)
	scope := testScope("alice", 1)
	session := n.newTestSession(t, scope)
	apply(t, n, control("alice", "microphone", protocol.SourceGrant, 1))
	key := sourceKey{keyOf(scope), "microphone"}

	session.mu.Lock() // the revoke's cleanup and the grant's keyframe request wait here
	revoked := controlInBackground(n, control("alice", "microphone", protocol.SourceRevoke, 2))
	reachRevision(n, key, 2)
	granted := controlInBackground(n, control("alice", "microphone", protocol.SourceGrant, 3))
	reachRevision(n, key, 3)
	pub := admitPublication(t, session, protocol.Track{Mid: "0", TrackName: "mic", Source: "microphone"}, webrtc.RTPCodecTypeAudio)
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

// A publication admitted at the revoke's own revision, after the revoke applied but
// before its cleanup ran, is not the revoke's to close: it has no lease, and a newer
// grant that applies before the cleanup lets it forward.
func TestARevokesCleanupKeepsAPublicationAdmittedAfterTheRevoke(t *testing.T) {
	n := leaseNode(t, time.Minute)
	scope := testScope("alice", 1)
	session := n.newTestSession(t, scope)
	apply(t, n, control("alice", "microphone", protocol.SourceGrant, 1))
	key := sourceKey{keyOf(scope), "microphone"}
	before := admitPublication(t, session, protocol.Track{Mid: "0", TrackName: "old-mic", Source: "microphone"}, webrtc.RTPCodecTypeAudio)
	session.published["0"] = before

	session.mu.Lock() // the revoke's cleanup and the grant's keyframe request wait here
	revoked := controlInBackground(n, control("alice", "microphone", protocol.SourceRevoke, 2))
	reachRevision(n, key, 2)
	pub := admitPublication(t, session, protocol.Track{Mid: "1", TrackName: "mic", Source: "microphone"}, webrtc.RTPCodecTypeAudio)
	session.published["1"] = pub
	if pub.authority.allows(monotonic(), monotonic()) {
		t.Fatal("a publication admitted while revoked has a lease")
	}
	granted := controlInBackground(n, control("alice", "microphone", protocol.SourceGrant, 3))
	reachRevision(n, key, 3)
	session.mu.Unlock()

	revoke, grant := <-revoked, <-granted
	if len(revoke.Results) != 1 || !revoke.Results[0].Applied || len(grant.Results) != 1 || !grant.Results[0].Applied {
		t.Fatalf("controls did not apply: revoke %+v, grant %+v", revoke, grant)
	}
	if closed := revoke.Results[0].Closed; len(closed) != 1 || closed[0].Mid != "0" || !before.closed.Load() {
		t.Fatalf("the revoke@2 cleanup did not close exactly the publication admitted before it: %+v", closed)
	}
	if pub.closed.Load() || session.published["1"] != pub || !pub.authority.allows(monotonic(), monotonic()) {
		t.Fatal("the revoke@2 cleanup closed a publication grant@3 lets forward")
	}
	// A revoke wins a tie, so revoke@3 closes what grant@3 admitted.
	session.published["2"] = admitPublication(t, session, protocol.Track{Mid: "2", TrackName: "new-mic", Source: "microphone"}, webrtc.RTPCodecTypeAudio)
	if closed := apply(t, n, control("alice", "microphone", protocol.SourceRevoke, 3)).Closed; len(closed) != 2 || closed[1].Mid != "2" {
		t.Fatalf("revoke@3 did not close the publications admitted under grant@3: %+v", closed)
	}
}

// reachRevision waits until the source's recorded control reaches revision, so a test
// can order controls whose cleanup waits on a held session lock.
func reachRevision(n *Node, key sourceKey, revision int64) {
	for {
		n.mu.Lock()
		reached := n.sources[key] != nil && n.sources[key].revision == revision
		n.mu.Unlock()
		if reached {
			return
		}
		runtime.Gosched()
	}
}

func controlInBackground(n *Node, request protocol.SourceControlRequest) chan protocol.SourceControlResponse {
	done := make(chan protocol.SourceControlResponse, 1)
	go func() {
		response, _ := n.ControlSources(request)
		done <- response
	}()
	return done
}

// hookWriter records a subscriber's writes and runs a hook inside each one, the
// moment a send is stuck in Pion.
type hookWriter struct {
	sequences []uint16
	hook      func(write int)
}

func (h *hookWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	h.sequences = append(h.sequences, header.SequenceNumber)
	if h.hook != nil {
		h.hook(len(h.sequences))
	}
	return header.MarshalSize() + len(payload), nil
}

func (h *hookWriter) Write(b []byte) (int, error) { return len(b), nil }

// Every egress write checks the lease at the time it sends, not when the packet
// arrived or when its loop began, because an earlier write can stall past the lease.
func TestAWriteThatStallsPastTheLeaseStopsTheSendsAfterIt(t *testing.T) {
	// leased is the bench publication under a one-minute lease, with its two "h"
	// viewers on hook writers. lapse ends the lease at once; send forwards ring packets.
	leased := func() (viewers [2]*subscription, writers [2]*hookWriter, lapse func(), send func(...int)) {
		pub, layers, _ := benchPublication(t)
		authority := &sourceAuthority{}
		now := monotonic()
		authority.window.Store(&leaseWindow{since: now, until: now + int64(time.Minute)})
		pub.authority = authority
		layers[0].lastAsked.Store(now + int64(time.Hour)) // the test publication has no peer to ask
		subscribers := *pub.subscribers.Load()
		for index := range viewers {
			viewers[index], writers[index] = subscribers[index], &hookWriter{}
			viewers[index].track.binding.Store(&egressBinding{writer: writers[index], ssrc: uint32(100 + index), payloadType: 96})
		}
		lapse = func() {
			authority.window.Store(&leaseWindow{since: authority.window.Load().since, until: monotonic()})
		}
		packets := cameraPackets("h")
		writer := &packetWriter{}
		var header rtp.Header
		send = func(order ...int) {
			for _, n := range order {
				stamp(packets[n], n)
				pub.forward(layers[0], packets[n], &header, writer)
			}
		}
		return viewers, writers, lapse, send
	}
	lapseOn := func(writer *hookWriter, write int, lapse func()) {
		writer.hook = func(n int) {
			if n == write {
				lapse()
			}
		}
	}

	t.Run("live", func(t *testing.T) {
		_, writers, lapse, send := leased()
		lapseOn(writers[0], 1, lapse)
		send(0)
		if len(writers[0].sequences) != 1 || len(writers[1].sequences) != 0 {
			t.Fatalf("the next viewer got %d packets after the lease lapsed in the first viewer's write", len(writers[1].sequences))
		}
	})
	t.Run("flush", func(t *testing.T) {
		_, writers, lapse, send := leased()
		lapseOn(writers[0], 2, lapse) // the flush's first write
		send(2, 1, 0)                 // the keyframe's start arrives last, so its switch flushes 1 and 2
		if got := len(writers[0].sequences); got != 2 {
			t.Fatalf("the viewer got %d packets, want the keyframe start and the one flushed write that lapsed", got)
		}
	})
	t.Run("resend", func(t *testing.T) {
		viewers, writers, lapse, send := leased()
		send(0, 1, 2, 3, 4)
		sent := slices.Clone(writers[0].sequences)
		if len(sent) != benchPacketsPerFrame {
			t.Fatalf("the viewer got %d of %d packets", len(sent), benchPacketsPerFrame)
		}
		lapseOn(writers[0], len(sent)+1, lapse) // the first resend
		viewers[0].retransmit(&rtcp.TransportLayerNack{Nacks: rtcp.NackPairsFromSequenceNumbers(sent[:2])}, 64, &packetWriter{})
		if got := len(writers[0].sequences) - len(sent); got != 1 {
			t.Fatalf("a NACK resent %d packets, want only the one whose write lapsed", got)
		}
	})
}

// Admission never evicts a source the same batch names: that would forget its revoke
// and let the batch's stale grant apply. With no other room, the batch is refused.
func TestAdmissionNeverEvictsASourceTheBatchNames(t *testing.T) {
	n := leaseNode(t, time.Minute)
	n.sourceLimit = 2
	apply(t, n, control("alice", "camera", protocol.SourceRevoke, 10)) // no Participant here has a session
	apply(t, n, control("dave", "camera", protocol.SourceRevoke, 1))
	batch := func(controls ...protocol.SourceControl) protocol.SourceControlRequest {
		return protocol.SourceControlRequest{TenantID: "tenant-1", EpisodeID: "episode-1", Controls: controls}
	}
	aliceGrant := protocol.SourceControl{ParticipantID: "alice", Source: "camera", Action: protocol.SourceGrant, Revision: 1}
	bobGrant := protocol.SourceControl{ParticipantID: "bob", Source: "camera", Action: protocol.SourceGrant, Revision: 1}

	response, err := n.ControlSources(batch(aliceGrant, bobGrant))
	if err != nil {
		t.Fatalf("a batch with room after evicting another entry was refused: %v", err)
	}
	if alice := response.Results[0]; alice.Applied || alice.Revision != 10 {
		t.Fatalf("a stale grant applied after its source's revoke was evicted: %+v", alice)
	}
	if !response.Results[1].Applied || len(n.sources) != 2 {
		t.Fatalf("bob's grant: %+v, table holds %d entries, limit 2", response.Results[1], len(n.sources))
	}

	carolGrant := protocol.SourceControl{ParticipantID: "carol", Source: "camera", Action: protocol.SourceGrant, Revision: 1}
	if _, err := n.ControlSources(batch(aliceGrant, bobGrant, carolGrant)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a batch with no room besides its own sources was admitted: %v", err)
	}
	if len(n.sources) != 2 || n.sources[sourceKey{participantKey{"tenant-1", "episode-1", "alice"}, "camera"}] == nil {
		t.Fatal("a refused batch changed the table")
	}
}
