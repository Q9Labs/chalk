package media

import (
	"errors"
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
	authority, _, _, err := n.authorityFor(scope, 0, source)
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

// The table of source controls is bounded, and a full table of live sessions' sources
// refuses a new control instead of forgetting a live revoke.
func TestTheSourceTableNeverEvictsALiveSessionsSource(t *testing.T) {
	n := leaseNode(t, time.Minute)
	n.sources.limit = 2
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

	n.sources.limit = 3
	apply(t, n, control("carol", "camera", protocol.SourceRevoke, 1)) // carol has no session
	if result := apply(t, n, control("bob", "camera", protocol.SourceGrant, 2)); !result.Applied {
		t.Fatal("an entry without a live session was not evicted for a new control")
	}
	if n.source(sourceKey{keyOf(testScope("carol", 1)), "camera"}) != nil {
		t.Fatal("the entry without a live session was kept")
	}
}

// The Episode floors share the source table's limit. Evicting into an Episode that has a
// floor costs nothing, and once the floors are full an entry that needs one stays.
func TestSourceFloorsStayBounded(t *testing.T) {
	n := leaseNode(t, time.Minute)
	n.sources.limit = 1
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
	if n.sources.Len() != 1 || len(n.sourceFloors) != 1 {
		t.Fatalf("table holds %d sources and %d floors, limit 1", n.sources.Len(), len(n.sourceFloors))
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
			pub.forward(layers[0], packets[next%len(packets)], false, &header, writer)
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

// reachRevision waits until the source's recorded control reaches revision, so a test
// can order controls whose cleanup waits on a held session lock.
func reachRevision(n *Node, key sourceKey, revision int64) {
	for {
		n.mu.Lock()
		reached := n.source(key) != nil && n.source(key).revision == revision
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
				pub.forward(layers[0], packets[n], false, &header, writer)
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

func TestAPacketQueuedInThePacerWhenItsSourceIsRevokedIsNeverSent(t *testing.T) {
	t.Run("revoked", func(t *testing.T) {
		pacedPacketsOfAStoppedSource(t, func(*Node, *sourceAuthority) {}, func(authority *sourceAuthority) { authority.window.Store(closedWindow) })
	})
	// The publisher left, so the table may evict its source, and a later revoke reaches
	// only the replacement entry.
	t.Run("evicted", func(t *testing.T) {
		pacedPacketsOfAStoppedSource(t, func(n *Node, authority *sourceAuthority) {
			n.mu.Lock()
			n.evictSource(authority.key)
			n.mu.Unlock()
		}, func(*sourceAuthority) {})
	})
}

func pacedPacketsOfAStoppedSource(t *testing.T, evict func(*Node, *sourceAuthority), revoke func(*sourceAuthority)) {
	t.Helper()
	n := leaseNode(t, time.Minute)
	apply(t, n, control("alice", "camera", protocol.SourceGrant, 1))
	authority := authorityOf(t, n, testScope("alice", 1), "camera")
	pub, layers, _ := benchPublication(t)
	pub.authority = authority
	viewer := (*pub.subscribers.Load())[0]
	wire := &wireWriter{}
	viewer.track.binding.Store(&egressBinding{writer: wire, ssrc: 100, payloadType: 96, rtxSSRC: 101, rtxPayloadType: 97, twccID: 3})
	layers[0].lastAsked.Store(monotonic() + int64(time.Hour)) // the test publication has no peer to ask
	transport := viewer.transport
	transport.mu.Lock()
	transport.setRates(0) // the bench paces without bound
	transport.refill(monotonic())
	transport.tokens = -1e6 // the pacer holds everything that arrives
	transport.mu.Unlock()

	var header rtp.Header
	writer := &packetWriter{}
	for index, raw := range cameraPackets("h")[:benchPacketsPerFrame] {
		stamp(raw, index)
		pub.forward(layers[0], raw, false, &header, writer)
	}
	queued := transport.queues[classVideo]
	if queued.empty() {
		t.Fatal("no video waits in the pacer, so the test proves nothing")
	}
	first := queued.items[queued.head].packet.seq
	viewer.retransmit(&rtcp.TransportLayerNack{Nacks: rtcp.NackPairsFromSequenceNumbers([]uint16{first})}, 64, writer)
	if transport.queues[classRepair].empty() {
		t.Fatal("no RTX repair waits in the pacer, so the test proves nothing")
	}

	evict(n, authority)
	revoke(authority)
	transport.mu.Lock()
	transport.tokens = 1e9
	transport.mu.Unlock()
	transport.drainOnce()
	if sent := wire.sent(); len(sent) != 0 {
		t.Fatalf("the pacer sent %d packets of a revoked source, first %+v", len(sent), sent[0])
	}
	if transport.queuedBytes != 0 {
		t.Fatalf("%d bytes of a revoked source still wait in the pacer", transport.queuedBytes)
	}
}

func (n *Node) source(key sourceKey) *sourceAuthority {
	authority, _ := n.sources.Get(key)
	return authority
}
