package media

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// A parked publication must not let a packet the pacer already queued, or a repair,
// reach the viewer after the park returns. Real Pion peers with transport-wide
// feedback exercise the same pacing path as a live subscriber.
func TestParkFencesQueuedPackets(t *testing.T) {
	for _, c := range []struct {
		name           string
		repair, resume bool
	}{
		{"queued video", false, false},
		{"queued repair", true, false},
		{"queued video before a quick unmute", false, true},
		{"queued repair before a quick unmute", true, true},
	} {
		t.Run(c.name, func(t *testing.T) { parkWithQueuedPacket(t, c.repair, c.resume) })
	}
}

// resume unmutes at once, so the pacer sees an unparked publication: what was queued before the
// mute still must not go out.
func parkWithQueuedPacket(t *testing.T, repair, resume bool) {
	received := make(chan uint16, 64)
	pair := newPionPair(t, func(packet *rtp.Packet) { received <- packet.SequenceNumber })
	authority := &sourceAuthority{}
	authority.window.Store(&leaseWindow{until: monotonic() + int64(time.Minute)})
	publisher := &Session{kind: ParticipantSession, id: "publisher", node: &Node{log: slog.New(slog.NewTextHandler(io.Discard, nil))}}
	pub := &publication{session: publisher, name: "camera", source: "camera", kind: webrtc.RTPCodecTypeVideo, authority: authority}
	transport := newTransport(&delayHistogram{}, 128<<10, make(chan struct{}))
	track := newEgressTrack(pub, transport)
	tx := pair.connect(t, track)
	owner := &Session{kind: ParticipantSession, subscribed: map[string]*subscription{}}
	sub := newSubscription(owner, pub, tx, track, layerRequest{}, nil)
	sub.mid = tx.Mid()
	owner.subscribed[sub.mid] = sub
	pub.addSubscriber(sub)
	if binding := track.binding.Load(); binding == nil || binding.twccID == 0 {
		t.Fatal("transport-wide feedback was not negotiated, so the pacing path would not be exercised")
	}
	writer := &packetWriter{}
	media := func(seq uint16) *rtpPacket {
		return &rtpPacket{arrival: monotonic(), timestamp: uint32(seq) * 3000, payload: []byte{0x10, 0x00, 0x01}}
	}
	if !sub.send(media(10), outgoing{seq: 10, timestamp: 9000}, classVideo, false, writer) {
		t.Fatal("warmup write failed")
	}
	select {
	case <-received:
	case <-time.After(5 * time.Second):
		t.Fatal("warmup packet did not arrive")
	}

	transport.mu.Lock()
	transport.tokens, transport.repair, transport.refilled = -1e9, 1e9, monotonic()
	transport.mu.Unlock()
	class := classVideo
	if repair {
		class = classRepair
	}
	if !sub.send(media(11), outgoing{seq: 11, timestamp: 12000}, class, repair, writer) {
		t.Fatal("paced send failed")
	}
	transport.mu.Lock()
	queued := transport.queuedBytes > 0
	transport.mu.Unlock()
	if !queued {
		t.Fatal("the packet was not queued by the pacer")
	}

	sentBefore := transport.sentPackets()
	pub.setHeld(true)
	if resume {
		pub.setHeld(false)
	}
	transport.mu.Lock()
	transport.tokens = 0
	transport.mu.Unlock()
	transport.drainOnce()
	// A repair travels on the RTX stream, which the viewer's track callback never reports.
	if sent := transport.sentPackets(); sent != sentBefore {
		t.Fatalf("the pacer wrote %d packets after the park returned", sent-sentBefore)
	}
	select {
	case seq := <-received:
		t.Fatalf("a queued packet (seq %d) reached the viewer after the park returned", seq)
	case <-time.After(500 * time.Millisecond):
	}
}

func (t *transport) sentPackets() (total uint64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, n := range t.counters.Sent {
		total += n
	}
	return total
}

// askedLongAgo is a keyframe request time far enough back that the rate limit lets the next one out.
const askedLongAgo = -int64(time.Hour)

// cameraWithOneLayer is a camera publication whose single layer received RTP a moment ago. Its
// publisher has an unconnected peer, so a keyframe request is recorded in lastAsked and goes nowhere.
func cameraWithOneLayer(t *testing.T) (*publication, *ingressLayer) {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	authority := &sourceAuthority{}
	authority.window.Store(&leaseWindow{until: monotonic() + int64(time.Minute)})
	publisher := &Session{kind: ParticipantSession, id: "publisher", pc: pc, node: &Node{log: slog.New(slog.NewTextHandler(io.Discard, nil))}}
	pub := &publication{session: publisher, name: "camera", source: "camera", kind: webrtc.RTPCodecTypeVideo, authority: authority}
	layer := &ingressLayer{}
	layer.lastRTP.Store(monotonic())
	layer.lastAsked.Store(askedLongAgo)
	pub.layers[0].Store(layer)
	return pub, layer
}

// A parked publication reads as inactive at once, in inspection and for its subscriptions,
// although its layers received RTP a moment ago.
func TestParkedPublicationReadsInactive(t *testing.T) {
	pub, _ := cameraWithOneLayer(t)
	sub := &subscription{pub: pub, revision: 1, target: -1}
	pub.addSubscriber(sub)
	sub.update(layerRequest{})
	_, _, active, _, _ := sub.state()

	now := monotonic()
	if !pub.inspectLayers(now)[0].Active || !pub.views(now)[0].active {
		t.Fatal("a publication with recent RTP must read as active before the park")
	}
	pub.setHeld(true)
	now = monotonic()
	if pub.inspectLayers(now)[0].Active || pub.views(now)[0].active {
		t.Fatal("a parked publication's layers read as active")
	}
	state, reason, parked, _, _ := sub.state()
	if state != protocol.SubscriptionPaused || reason != protocol.PauseSourceInactive || parked == active {
		t.Fatalf("a retained subscription of a parked publication reads %q (%q) at revision %d, was %d", state, reason, parked, active)
	}
	pub.setHeld(false)
	state, _, resumed, _, _ := sub.state()
	if state != protocol.SubscriptionActive || resumed == parked || resumed == active {
		t.Fatalf("a resumed publication's subscription reads %q at revision %d, after %d and %d", state, resumed, active, parked)
	}
}
