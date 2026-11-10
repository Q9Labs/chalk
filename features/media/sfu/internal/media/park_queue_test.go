package media

import (
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
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
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.TransportCCURI}, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine))
	server, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	viewer, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	received := make(chan uint16, 64)
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			received <- packet.SequenceNumber
		}
	})
	connected := make(chan struct{}, 1)
	server.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	authority := &sourceAuthority{}
	authority.window.Store(&leaseWindow{until: monotonic() + int64(time.Minute)})
	publisher := &Session{id: "publisher", node: &Node{log: slog.New(slog.NewTextHandler(io.Discard, nil))}}
	pub := &publication{session: publisher, name: "camera", source: "camera", kind: webrtc.RTPCodecTypeVideo, authority: authority}
	transport := newTransport(&delayHistogram{}, 128<<10, make(chan struct{}))
	track := newEgressTrack(pub, transport)
	tx, err := server.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	offer, err := server.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(server)
	if err = server.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err = viewer.SetRemoteDescription(*server.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered = webrtc.GatheringCompletePromise(viewer)
	if err = viewer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err = server.SetRemoteDescription(*viewer.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(10 * time.Second):
		t.Fatal("peer did not connect")
	}
	owner := &Session{subscribed: map[string]*subscription{}}
	sub := newSubscription(owner, pub, newSection(tx), track, layerRequest{}, nil)
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
	publisher := &Session{id: "publisher", pc: pc, node: &Node{log: slog.New(slog.NewTextHandler(io.Discard, nil))}}
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

// A viewer that subscribes while the camera is muted has no layer to follow. The resume must
// select one and ask the publisher for a keyframe, or that viewer stays on a black tile.
func TestSubscribeWhileParkedGetsALayerOnResume(t *testing.T) {
	pub, layer := cameraWithOneLayer(t)
	pub.setHeld(true)

	sub := &subscription{pub: pub, revision: 1, target: -1}
	pub.addSubscriber(sub)
	sub.update(layerRequest{})
	if sub.target >= 0 {
		t.Fatalf("a viewer that subscribed to a parked camera selected layer %d", sub.target)
	}
	pub.setHeld(false)
	if sub.target < 0 {
		t.Fatal("the resume left a viewer that subscribed during the mute without a layer")
	}
	if layer.lastAsked.Load() == askedLongAgo {
		t.Fatal("the resume did not ask the publisher for a keyframe for that viewer")
	}
}

// blockingWriter holds the first write until released, so a test can park a publication while
// one packet is already past the pacer's check.
type blockingWriter struct {
	entered chan struct{}
	release chan struct{}
	writes  atomic.Int32
}

func (w *blockingWriter) WriteRTP(_ *rtp.Header, payload []byte) (int, error) {
	if w.writes.Add(1) == 1 {
		close(w.entered)
		<-w.release
	}
	return len(payload), nil
}

func (w *blockingWriter) Write(b []byte) (int, error) { return len(b), nil }

// The pacer checks a packet and then writes it with its lock released, so a park that returns
// while one write is under way cannot recall that packet. The bound is that single packet per
// viewer transport: everything still queued behind it is dropped, and a later resume does not
// bring it back.
func TestParkLeavesAtMostTheWriteUnderWay(t *testing.T) {
	pub, _ := cameraWithOneLayer(t)
	sub := &subscription{pub: pub, revision: 1, target: -1}
	writer := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	transport := newTransport(&delayHistogram{}, 128<<10, make(chan struct{}))
	binding := &egressBinding{writer: writer, ssrc: 1, payloadType: 96, twccID: 1}
	transport.mu.Lock()
	transport.tokens, transport.refilled = -1e9, monotonic()
	transport.mu.Unlock()
	scratch := &packetWriter{}
	for seq := uint16(1); seq <= 3; seq++ {
		packet := egressPacket{binding: binding, authority: pub.authority, sub: sub, resumes: pub.resumes.Load(), arrival: monotonic(), class: classVideo, seq: seq, payload: []byte{1, 2, 3}}
		if !transport.send(&packet, scratch) {
			t.Fatalf("packet %d was not accepted", seq)
		}
	}
	transport.mu.Lock()
	transport.tokens = 1e9
	transport.mu.Unlock()

	drained := make(chan struct{})
	go func() { defer close(drained); transport.drainOnce() }()
	select {
	case <-writer.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the pacer did not start a write")
	}
	pub.setHeld(true)
	pub.setHeld(false)
	close(writer.release)
	select {
	case <-drained:
	case <-time.After(5 * time.Second):
		t.Fatal("the pacer did not finish")
	}
	if writes := writer.writes.Load(); writes != 1 {
		t.Fatalf("%d packets were written across the park, want only the one under way", writes)
	}
}

// After a mute longer than the idle window the layer reads idle at the resume, so the resume
// itself finds nothing to select. The first packet that arrives after it must then ask for the
// keyframe the viewer needs.
func TestLongMuteAsksForAKeyframeOnTheFirstPacketAfterResume(t *testing.T) {
	pub, layer := cameraWithOneLayer(t)
	sub := &subscription{pub: pub, track: &egressTrack{}, revision: 1, target: -1}
	pub.addSubscriber(sub)
	sub.update(layerRequest{})
	pub.setHeld(true)
	layer.lastRTP.Store(monotonic() - 2*int64(layerIdleAfter))
	layer.lastAsked.Store(askedLongAgo)
	pub.setHeld(false)
	if sub.target >= 0 {
		t.Fatal("an idle layer was selected at the resume")
	}
	if layer.lastAsked.Load() != askedLongAgo {
		t.Fatal("the resume asked for a keyframe from a layer with no media")
	}

	raw, err := (&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: 7, Timestamp: 9000, SSRC: 1}, Payload: []byte{0x10, 0x00, 0x01}}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	var header rtp.Header
	pub.forward(layer, raw, false, &header, &packetWriter{})
	if sub.target < 0 {
		t.Fatal("the first packet after the resume did not select a layer")
	}
	if layer.lastAsked.Load() == askedLongAgo {
		t.Fatal("the first packet after the resume did not ask for a keyframe")
	}
}
