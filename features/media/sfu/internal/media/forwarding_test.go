package media

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// The real-VP8 test in tests/layers_test.go proves switching end to end. These
// cover what it cannot reach: 7-bit picture IDs, a retransmission from before a
// switch, the selection rules it does not exercise, and history eviction.

// vp8Packet is one packet of a frame with a 7-bit picture ID and TL0PICIDX.
func vp8Packet(extSeq uint64, timestamp uint32, pictureID, tl0 uint8, start, key bool) rtpPacket {
	descriptor := []byte{0x80, 0xC0, pictureID & 0x7f, tl0}
	if start {
		descriptor[0] |= 0x10
	}
	header := byte(0x01) // inter frame
	if key {
		header = 0x00
	}
	p := rtpPacket{extSeq: extSeq, timestamp: timestamp, payload: append(descriptor, header, 'x')}
	p.vp8, p.hasVP8 = parseVP8(p.payload)
	return p
}

func TestSwitchContinuesSevenBitPictureIDsAndKeepsOldSegmentsForNACKs(t *testing.T) {
	tr := translator{clockRate: 90000}
	var sent []outgoing
	// Layer 0: five single-packet frames whose 7-bit picture ID wraps.
	for i := range 5 {
		p := vp8Packet(100+uint64(i), 9000+uint32(i)*3000, uint8(125+i), uint8(10+i), true, i == 0)
		var out outgoing
		if i == 0 {
			out = tr.begin(0, &p)
		} else {
			var ok bool
			if out, ok = tr.forward(&p); !ok {
				t.Fatalf("packet %d dropped", i)
			}
		}
		sent = append(sent, out)
	}
	// Layer 1 has its own sequence, timestamp and picture ID spaces.
	key := vp8Packet(70000, 500, 50, 200, true, true)
	switched := tr.begin(1, &key)
	last := sent[len(sent)-1]
	if switched.seq != last.seq+1 {
		t.Fatalf("switch sequence %d after %d", switched.seq, last.seq)
	}
	if int32(switched.timestamp-last.timestamp) <= 0 {
		t.Fatalf("switch timestamp %d after %d", switched.timestamp, last.timestamp)
	}
	if switched.vp8.pictureID != (last.vp8.pictureID+1)&0x7f || switched.vp8.tl0 != last.vp8.tl0+1 {
		t.Fatalf("switch picture ID %d TL0 %d after %d %d", switched.vp8.pictureID, switched.vp8.tl0, last.vp8.pictureID, last.vp8.tl0)
	}
	payload := bytes.Clone(key.payload)
	switched.vp8.apply(&key.vp8, payload)
	if rewritten, _ := parseVP8(payload); rewritten.pictureIDBits != 7 || rewritten.pictureID != switched.vp8.pictureID {
		t.Fatalf("rewritten descriptor %+v, want a 7-bit picture ID %d", rewritten, switched.vp8.pictureID)
	}

	// A NACK for a packet sent before the switch maps back to layer 0 and
	// repeats exactly what the subscriber first received.
	seg, ext, ok := tr.lookup(sent[2].seq)
	if !ok || seg.layer != 0 || ext != 102 {
		t.Fatalf("lookup of %d: layer %d ext %d ok %v, want layer 0 ext 102", sent[2].seq, seg.layer, ext, ok)
	}
	again := vp8Packet(102, 9000+2*3000, 127, 12, true, false)
	if repeat := seg.translate(&again); repeat != sent[2] {
		t.Fatalf("retransmission %+v, first sent %+v", repeat, sent[2])
	}
	if seg, ext, ok := tr.lookup(switched.seq); !ok || seg.layer != 1 || ext != 70000 {
		t.Fatalf("lookup of the switch packet: layer %d ext %d ok %v", seg.layer, ext, ok)
	}
	// A layer 1 packet from before its keyframe would reuse a sent sequence number.
	early := vp8Packet(69999, 0, 49, 199, false, false)
	if _, ok := tr.forward(&early); ok {
		t.Fatal("a packet older than the switch point was forwarded")
	}
}

func TestPickLayer(t *testing.T) {
	h, l := layerView{rid: "h", active: true}, layerView{rid: "l", active: true}
	off := func(v layerView) layerView { v.active = false; return v }
	for _, c := range []struct {
		name    string
		request layerRequest
		layers  []layerView
		want    int
	}{
		{"the wanted layer", layerRequest{ceiling: "h", fallback: true}, []layerView{l, h}, 1},
		{"fallback takes the first active RID in ASCII order", layerRequest{ceiling: "q", fallback: true}, []layerView{l, h, off(layerView{rid: "q"})}, 1},
		{"no fallback pauses", layerRequest{ceiling: "h"}, []layerView{l, off(h)}, -1},
		{"a start RID below the ceiling", layerRequest{ceiling: "h", start: "l"}, []layerView{h, l}, 1},
		{"a start RID above the ceiling is ignored", layerRequest{ceiling: "l", start: "h"}, []layerView{h, l}, 1},
		{"a track without simulcast always serves", layerRequest{ceiling: "h"}, []layerView{{rid: "", active: true}}, 0},
		{"nothing active", layerRequest{ceiling: "h", fallback: true}, []layerView{off(h), off(l)}, -1},
	} {
		if got := pickLayer(c.request, c.layers); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestPauseReasonsAndRevision(t *testing.T) {
	s := &subscription{pub: &publication{kind: webrtc.RTPCodecTypeVideo, authority: freeAuthority()}, target: -1, revision: 1, translator: translator{clockRate: 90000}}
	views := []layerView{{rid: "h", active: true}, {rid: "l", active: true}}
	state := func() (string, uint64) {
		state, reason, revision, _, _ := s.state()
		// The open lease window adds 1 to the subscription's own revision.
		return state + "/" + reason, revision - 1
	}
	s.request = layerRequest{ceiling: "h", paused: true}
	s.reselect(views)
	if got, revision := state(); got != protocol.SubscriptionPaused+"/"+protocol.PauseViewer || revision != 2 || s.interest.Load() != 0 {
		t.Fatalf("viewer pause: %s revision %d interest %b", got, revision, s.interest.Load())
	}
	s.request.paused = false
	if pending := s.reselect(views); pending != 0 || s.interest.Load() != 1 {
		t.Fatalf("resume: pending %d interest %b, want layer 0", pending, s.interest.Load())
	}
	if got, revision := state(); got != protocol.SubscriptionActive+"/" || revision != 3 {
		t.Fatalf("resumed: %s revision %d", got, revision)
	}
	views[0].active = false
	s.reselect(views)
	if got, revision := state(); got != protocol.SubscriptionPaused+"/"+protocol.PauseSourceInactive || revision != 4 {
		t.Fatalf("source inactive: %s revision %d", got, revision)
	}
	s.reselect(views)
	if _, revision := state(); revision != 4 {
		t.Fatalf("an unchanged state moved the revision to %d", revision)
	}
}

// TestAnInactiveForwardedLayerResumesOnlyOnAKeyframe stops forwarding "h" when
// it goes idle, so when it resumes mid-GOP before "l" sends a keyframe, its
// delta frames wait for an "h" keyframe instead of reaching the decoder.
func TestAnInactiveForwardedLayerResumesOnlyOnAKeyframe(t *testing.T) {
	s := &subscription{
		pub: &publication{kind: webrtc.RTPCodecTypeVideo, authority: freeAuthority()}, target: -1, revision: 1, translator: translator{clockRate: 90000},
		request: layerRequest{ceiling: "h", fallback: true},
	}
	views := []layerView{{rid: "h", active: true}, {rid: "l", active: true}}
	route := func(p rtpPacket) (outgoing, bool) {
		s.mu.Lock()
		defer s.mu.Unlock()
		out, send, _ := s.route(0, &p)
		return out, send
	}
	if pending := s.reselect(views); pending != 0 {
		t.Fatalf("first selection waits for layer %d, want 0", pending)
	}
	route(vp8Packet(100, 1000, 1, 1, true, true))
	last, _ := route(vp8Packet(101, 4000, 2, 1, true, false))

	views[0].active = false
	if pending := s.reselect(views); pending != 1 {
		t.Fatalf("h idle: waits for layer %d, want the fallback 1", pending)
	}
	views[0].active = true
	if pending := s.reselect(views); pending != 0 {
		t.Fatalf("h resumed: waits for layer %d, want a keyframe of 0", pending)
	}
	if _, send := route(vp8Packet(102, 7000, 3, 1, true, false)); send {
		t.Fatal("a delta frame of the resumed layer was forwarded before its keyframe")
	}
	keyframe, send := route(vp8Packet(103, 10000, 4, 2, true, true))
	if !send || keyframe.seq != last.seq+1 {
		t.Fatalf("resumed keyframe: sent %v at sequence %d after %d", send, keyframe.seq, last.seq)
	}
}

func TestAStaleSnapshotNeverRevivesAClosedPublication(t *testing.T) {
	pub := &publication{kind: webrtc.RTPCodecTypeVideo, authority: freeAuthority()}
	pub.closed.Store(true)
	s := &subscription{pub: pub, target: -1, translator: translator{clockRate: 90000}, request: layerRequest{fallback: true}}
	if pending := s.reselect([]layerView{{rid: "h", active: true}}); pending >= 0 {
		t.Fatalf("closed publication: waits for layer %d, want none", pending)
	}
	if s.reason != protocol.PauseSourceInactive {
		t.Fatalf("closed publication: reason %q, want %q", s.reason, protocol.PauseSourceInactive)
	}
}

func TestHistoryEvictsOverwrittenAndOldPackets(t *testing.T) {
	h := newHistory(100, 4)
	now := monotonic()
	store := func(ext uint64, fill byte, arrival int64) {
		h.store(&rtpPacket{extSeq: ext, timestamp: uint32(ext), arrival: arrival, payload: bytes.Repeat([]byte{fill}, 40)})
	}
	load := func(ext uint64, at int64) ([]byte, bool) {
		dst := make([]byte, maxPayloadBytes)
		p, ok := h.load(ext, at, dst)
		return p.payload, ok
	}
	store(1, 'a', now)
	store(2, 'b', now)
	store(3, 'c', now) // does not fit before the arena's end, so it wraps over packet 1
	if _, ok := load(1, now); ok {
		t.Fatal("an overwritten packet loaded")
	}
	if payload, ok := load(2, now); !ok || !bytes.Equal(payload, bytes.Repeat([]byte{'b'}, 40)) {
		t.Fatalf("packet 2: %q %v", payload, ok)
	}
	if payload, ok := load(3, now); !ok || !bytes.Equal(payload, bytes.Repeat([]byte{'c'}, 40)) {
		t.Fatalf("packet 3: %q %v", payload, ok)
	}
	store(7, 'd', now) // shares packet 3's slot
	if _, ok := load(3, now); ok {
		t.Fatal("a packet whose slot was reused loaded")
	}
	if _, ok := load(7, now+int64(historyAge)+1); ok {
		t.Fatal("a packet older than the history age loaded")
	}
}

// TestPushMIDRules covers the MID bugs from issue #810.
func TestPushMIDRules(t *testing.T) {
	t.Run("a refused entry never leaves its MID's other entry on a stopped section", func(t *testing.T) {
		node := newTestNode(t, func(cfg *config.Config) { cfg.MaxPublishedPerSession = 2 })
		session := node.newTestSession(t, testScope("alice", 1))
		peer := newTestPeer(t)
		peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 2)
		offer := peer.offer(t)
		mids := peer.mids()
		// The second entry reuses a name, so it is refused and its new section
		// stopped; the third names that section again under a new name.
		response, err := session.AddTracks(context.Background(), protocol.TracksRequest{
			OperationID: op(), Scope: session.scope, SessionDescription: offer,
			Tracks: []protocol.Track{
				{Location: protocol.LocationLocal, Mid: mids[0], TrackName: "mic-a", Source: "microphone"},
				{Location: protocol.LocationLocal, Mid: mids[1], TrackName: "mic-a", Source: "microphone"},
				{Location: protocol.LocationLocal, Mid: mids[1], TrackName: "mic-b", Source: "microphone"},
			},
		})
		// Two sections fit a limit of two, however many entries name them.
		if err != nil {
			t.Fatal(err)
		}
		if len(response.Tracks) != 1 || response.Tracks[0].Mid != mids[0] || len(response.TrackErrors) != 2 {
			t.Fatalf("response: %+v", response)
		}
		for _, section := range strings.Split(response.SessionDescription.SDP, "m=")[1:] {
			if strings.Contains(section, "a=mid:"+mids[0]+"\r\n") && strings.Contains(section, "a=inactive") {
				t.Fatal("the published section is inactive")
			}
		}
	})

	t.Run("a closed MID is never published again", func(t *testing.T) {
		node := newTestNode(t, nil)
		session := node.newTestSession(t, testScope("alice", 1))
		peer := newTestPeer(t)
		peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 1)
		push := func(name string) protocol.TracksResponse {
			offer := peer.offer(t)
			response, err := session.AddTracks(context.Background(), protocol.TracksRequest{
				OperationID: op(), Scope: session.scope, SessionDescription: offer,
				Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: peer.mids()[0], TrackName: name, Source: "microphone"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: response.SessionDescription.SDP}); err != nil {
				t.Fatal(err)
			}
			return response
		}
		if first := push("mic"); len(first.Tracks) != 1 {
			t.Fatalf("first push: %+v", first)
		}
		if _, err := session.CloseTracks(context.Background(), protocol.CloseTracksRequest{OperationID: op(), Scope: session.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: peer.mids()[0]}}}); err != nil {
			t.Fatal(err)
		}
		again := push("mic-again")
		if len(again.Tracks) != 0 || len(again.TrackErrors) != 1 || again.TrackErrors[0].Code != protocol.TrackCodeInvalid {
			t.Fatalf("push on the closed MID: %+v", again)
		}
	})
}

// TestPausedSubscriptionForwardsNothingAndResumesOnAKeyframe pauses one of two
// subscribers of a real VP8 stream, as an update without SDP would.
func TestPausedSubscriptionForwardsNothingAndResumesOnAKeyframe(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	apply(t, node, control("alice", "camera", protocol.SourceGrant, 1))
	camera, err := webrtc.NewTrackLocalStaticRTP(vp8Capability, "cam", "alice")
	if err != nil {
		t.Fatal(err)
	}
	sender := newTestPeer(t)
	if _, err := sender.pc.AddTrack(camera); err != nil {
		t.Fatal(err)
	}
	offer := sender.offer(t)
	pushed, err := publisher.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: op(), Scope: publisher.scope, SessionDescription: offer, Tracks: localTracks("cam", sender.mids(), "camera"),
	})
	if err != nil || len(pushed.Tracks) != 1 {
		t.Fatalf("push: %+v %v", pushed, err)
	}
	if err := sender.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	var keyframeRequests atomic.Int64
	go func() {
		for {
			packets, _, err := sender.pc.GetSenders()[0].ReadRTCP()
			if err != nil {
				return
			}
			for _, packet := range packets {
				if _, ok := packet.(*rtcp.PictureLossIndication); ok {
					keyframeRequests.Add(1)
				}
			}
		}
	}()
	// One packet per frame and a keyframe every 15 frames; PLIs are ignored.
	ctx, stop := context.WithCancel(context.Background())
	sending := make(chan struct{})
	t.Cleanup(func() { stop(); <-sending })
	go func() {
		defer close(sending)
		ticker := time.NewTicker(time.Second / 30)
		defer ticker.Stop()
		for frame := 0; ; frame++ {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			header := byte(0x01)
			if frame%15 == 0 {
				header = 0x00
			}
			payload := []byte{0x90, 0x80, 0x80 | byte(frame>>8&0x7f), byte(frame), header, 'v'}
			_ = camera.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: uint16(frame), Timestamp: uint32(frame * 3000), Marker: true}, Payload: payload})
		}
	}()

	type viewer struct {
		session *Session
		peer    *testPeer
		mid     string
		mu      sync.Mutex
		packets []*rtp.Packet
	}
	join := func(name string) *viewer {
		v := &viewer{session: node.newTestSession(t, testScope(name, 1)), peer: newTestPeer(t)}
		v.peer.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			for {
				packet, _, err := remote.ReadRTP()
				if err != nil {
					return
				}
				v.mu.Lock()
				v.packets = append(v.packets, packet)
				v.mu.Unlock()
			}
		})
		pull := pullRequest(v.session, publisher, "cam-0")
		pull.OperationID = op()
		pulled, err := v.session.AddTracks(context.Background(), pull)
		if err != nil || len(pulled.Tracks) != 1 {
			t.Fatalf("pull: %+v %v", pulled, err)
		}
		v.mid = pulled.Tracks[0].Mid
		if err := v.session.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), SessionDescription: v.peer.answer(t, pulled.SessionDescription)}); err != nil {
			t.Fatal(err)
		}
		return v
	}
	received := func(v *viewer) []*rtp.Packet {
		v.mu.Lock()
		defer v.mu.Unlock()
		return append([]*rtp.Packet(nil), v.packets...)
	}
	subscription := func(v *viewer) *subscription {
		v.session.mu.Lock()
		defer v.session.mu.Unlock()
		return v.session.subscribed[v.mid]
	}
	inspected := func(v *viewer) protocol.InspectedTrack {
		response, err := v.session.Inspect()
		if err != nil || len(response.Tracks) != 1 {
			t.Fatalf("inspect: %+v %v", response, err)
		}
		return response.Tracks[0]
	}
	assertContinuous := func(label string, packets []*rtp.Packet) {
		for i := 1; i < len(packets); i++ {
			if packets[i].SequenceNumber != packets[i-1].SequenceNumber+1 {
				t.Fatalf("%s: sequence went %d then %d", label, packets[i-1].SequenceNumber, packets[i].SequenceNumber)
			}
		}
	}

	bob, carol := join("bob"), join("carol")
	eventually(t, "both viewers receiving", 10*time.Second, func() bool { return len(received(bob)) >= 20 && len(received(carol)) >= 20 })
	bobSDP := bob.peer.pc.LocalDescription().SDP

	subscription(bob).update(layerRequest{fallback: true, paused: true})
	time.Sleep(100 * time.Millisecond) // packets already in flight
	before := received(bob)
	time.Sleep(700 * time.Millisecond)
	if got := len(received(bob)); got != len(before) {
		t.Fatalf("a paused subscription received %d packets", got-len(before))
	}
	track := inspected(bob)
	if track.Mid != bob.mid || track.Subscription == nil || track.Subscription.State != protocol.SubscriptionPaused || track.Subscription.Reason != protocol.PauseViewer {
		t.Fatalf("paused subscription inspects as %+v %+v", track, track.Subscription)
	}

	subscription(bob).update(layerRequest{fallback: true})
	eventually(t, "bob to resume", 5*time.Second, func() bool { return len(received(bob)) > len(before) })
	resumed := received(bob)[len(before)]
	if resumed.Payload[4]&0x01 != 0 {
		t.Fatal("the resumed stream starts on a delta frame")
	}
	if resumed.SequenceNumber != before[len(before)-1].SequenceNumber+1 {
		t.Fatalf("resumed at sequence %d after %d", resumed.SequenceNumber, before[len(before)-1].SequenceNumber)
	}
	if track := inspected(bob); track.Mid != bob.mid || track.Subscription.State != protocol.SubscriptionActive {
		t.Fatalf("resumed subscription inspects as %+v", track.Subscription)
	}
	if bob.peer.pc.LocalDescription().SDP != bobSDP || len(bob.peer.pc.GetTransceivers()) != 1 {
		t.Fatal("pausing or resuming changed the viewer's session description")
	}
	assertContinuous("carol", received(carol))
	assertContinuous("bob", received(bob))

	// A NACK for a packet the SFU no longer holds asks the publisher for a
	// keyframe, because the lost packet may belong to a reference frame.
	time.Sleep(2 * keyframeInterval)
	asked := keyframeRequests.Load()
	latest := received(bob)[len(received(bob))-1]
	nack := &rtcp.TransportLayerNack{SenderSSRC: 1, MediaSSRC: latest.SSRC, Nacks: rtcp.NackPairsFromSequenceNumbers([]uint16{latest.SequenceNumber - 2000})}
	if err := bob.peer.pc.WriteRTCP([]rtcp.Packet{nack}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "a keyframe request for the lost packet", 2*time.Second, func() bool { return keyframeRequests.Load() > asked })
}

// recordingWriter keeps the sequence numbers a subscriber was sent.
type recordingWriter struct{ sequences []uint16 }

func (r *recordingWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	r.sequences = append(r.sequences, header.SequenceNumber)
	return header.MarshalSize() + len(payload), nil
}

func (r *recordingWriter) Write(b []byte) (int, error) { return len(b), nil }

func TestALayerThatResumesBetweenMonitorTicksWaitsForAKeyframe(t *testing.T) {
	pub, layers, _ := benchPublication(t)
	viewer := (*pub.subscribers.Load())[0] // forwards "h"
	for _, layer := range layers {         // the bench has no peer connection to send a PLI on
		layer.lastAsked.Store(monotonic())
	}
	recorder := &recordingWriter{}
	viewer.track.binding.Store(&egressBinding{writer: recorder, ssrc: 100, payloadType: 96})
	packets := cameraPackets("h")
	var header rtp.Header
	writer := &packetWriter{}
	send := func(from, to int) {
		for n := from; n < to; n++ {
			stamp(packets[n], n)
			pub.forward(layers[0], packets[n], false, &header, writer)
		}
	}
	send(0, 2*benchPacketsPerFrame)
	sent := len(recorder.sequences)
	if sent == 0 {
		t.Fatal("the keyframe was not forwarded")
	}
	layers[0].lastRTP.Store(monotonic() - int64(activeWindow) - int64(time.Millisecond))
	send(2*benchPacketsPerFrame, 3*benchPacketsPerFrame)
	if got := len(recorder.sequences) - sent; got != 0 {
		t.Fatalf("forwarded %d delta packets after an unobserved gap", got)
	}
}

func TestRetransmissionStopsWhilePausedAndOnceTheSourceCloses(t *testing.T) {
	pub, layers, _ := benchPublication(t)
	subscribers := *pub.subscribers.Load()
	paused, watching := subscribers[0], subscribers[1] // both forward "h"
	recorders := map[*subscription]*recordingWriter{}
	for _, s := range []*subscription{paused, watching} {
		recorders[s] = &recordingWriter{}
		s.track.binding.Store(&egressBinding{writer: recorders[s], ssrc: 100, payloadType: 96})
	}
	packets := cameraPackets("h")
	var header rtp.Header
	writer := &packetWriter{}
	for n := range 2 * benchPacketsPerFrame {
		stamp(packets[n], n)
		pub.forward(layers[0], packets[n], false, &header, writer)
	}
	// nack reports a packet s was sent as lost and returns how many s got again.
	nack := func(s *subscription) int {
		recorder := recorders[s]
		sent := len(recorder.sequences)
		s.retransmit(&rtcp.TransportLayerNack{Nacks: rtcp.NackPairsFromSequenceNumbers([]uint16{recorder.sequences[3]})}, 10, writer)
		return len(recorder.sequences) - sent
	}
	if got := nack(paused); got != 1 {
		t.Fatalf("an active subscription resent %d packets for one NACK", got)
	}

	paused.update(layerRequest{ceiling: "h", fallback: true, paused: true})
	if got := nack(paused); got != 0 {
		t.Fatalf("a paused subscription resent %d packets", got)
	}

	_, _, revision, _, _ := watching.state()
	pub.close()
	state, reason, closedRevision, _, effective := watching.state()
	if state != protocol.SubscriptionPaused || reason != protocol.PauseSourceInactive || effective != "" || closedRevision <= revision {
		t.Fatalf("after its source closed the subscription inspects as %s %s %q revision %d", state, reason, effective, closedRevision)
	}
	if got := nack(watching); got != 0 {
		t.Fatalf("a subscription whose source closed resent %d packets", got)
	}
	for _, layer := range layers {
		if layer.history.Load() != nil {
			t.Fatalf("layer %q kept its history after the publication closed", layer.rid)
		}
	}
}

func TestASubscriptionClosedBeforeItStartsNeverJoins(t *testing.T) {
	pub, _, _ := benchPublication(t)
	before := len(*pub.subscribers.Load())
	s := &subscription{pub: pub, track: &egressTrack{codec: vp8Capability, kind: pub.kind}, request: layerRequest{ceiling: "h"}, target: -1, revision: 1}
	s.detach() // the subscriber's session closed between pull and start
	s.start()
	if got := len(*pub.subscribers.Load()); got != before {
		t.Fatalf("a closed subscription joined its publication: %d subscribers, want %d", got, before)
	}
}
