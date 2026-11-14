package media

import (
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

func TestPickLayer(t *testing.T) {
	h, l := layerView{rid: "h", active: true}, layerView{rid: "l", active: true}
	off := func(v layerView) layerView { v.active = false; return v }
	for _, c := range []struct {
		name    string
		request layerRequest
		limit   string
		layers  []layerView
		want    int
	}{
		{"the wanted layer", layerRequest{ceiling: "h", fallback: true}, "", []layerView{l, h}, 1},
		{"fallback takes the first active RID in ASCII order", layerRequest{ceiling: "q", fallback: true}, "", []layerView{l, h, off(layerView{rid: "q"})}, 1},
		{"no fallback pauses", layerRequest{ceiling: "h"}, "", []layerView{l, off(h)}, -1},
		{"a start RID below the ceiling", layerRequest{ceiling: "h", start: "l"}, "", []layerView{h, l}, 1},
		{"a start RID above the ceiling is ignored", layerRequest{ceiling: "l", start: "h"}, "", []layerView{h, l}, 1},
		{"a track without simulcast always serves", layerRequest{ceiling: "h"}, lowestLayer, []layerView{{rid: "", active: true}}, 0},
		{"nothing active", layerRequest{ceiling: "h", fallback: true}, "l", []layerView{off(h), off(l)}, -1},
		{"a limit lowers the wanted layer", layerRequest{ceiling: "h"}, "l", []layerView{h, l}, 1},
		{"the lowest layer limit", layerRequest{ceiling: "h"}, lowestLayer, []layerView{h, l}, 1},
		{"a limit never raises", layerRequest{ceiling: "l"}, "h", []layerView{h, l}, 1},
		{"a missing layer still follows the request", layerRequest{ceiling: "h"}, "h", []layerView{l, off(h)}, -1},
		{"a limit with only a better layer left keeps it", layerRequest{ceiling: "h"}, "l", []layerView{h, off(l)}, 0},
	} {
		if got := pickLayer(c.request, c.limit, c.layers); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
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
