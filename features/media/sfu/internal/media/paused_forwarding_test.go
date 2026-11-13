package media

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// TestPausedSubscriptionForwardsNothingAndResumesOnAKeyframe pauses one of two
// subscribers of a real VP8 stream, as an update without SDP would.
func TestPausedSubscriptionForwardsNothingAndResumesOnAKeyframe(t *testing.T) {
	node := newTestNode(t, nil)
	publisher, keyframeRequests := startVP8Camera(t, node)

	bob, carol := joinViewer(t, node, publisher, "bob"), joinViewer(t, node, publisher, "carol")
	eventually(t, "both viewers receiving", 10*time.Second, func() bool { return len(bob.received()) >= 20 && len(carol.received()) >= 20 })
	bobSDP := bob.peer.pc.LocalDescription().SDP

	bob.subscription().update(layerRequest{fallback: true, paused: true})
	time.Sleep(100 * time.Millisecond) // packets already in flight
	before := bob.received()
	time.Sleep(700 * time.Millisecond)
	if got := len(bob.received()); got != len(before) {
		t.Fatalf("a paused subscription received %d packets", got-len(before))
	}
	track := bob.inspected(t)
	if track.Mid != bob.mid || track.Subscription == nil || track.Subscription.State != protocol.SubscriptionPaused || track.Subscription.Reason != protocol.PauseViewer {
		t.Fatalf("paused subscription inspects as %+v %+v", track, track.Subscription)
	}

	bob.subscription().update(layerRequest{fallback: true})
	eventually(t, "bob to resume", 5*time.Second, func() bool { return len(bob.received()) > len(before) })
	resumed := bob.received()[len(before)]
	if resumed.Payload[4]&0x01 != 0 {
		t.Fatal("the resumed stream starts on a delta frame")
	}
	if resumed.SequenceNumber != before[len(before)-1].SequenceNumber+1 {
		t.Fatalf("resumed at sequence %d after %d", resumed.SequenceNumber, before[len(before)-1].SequenceNumber)
	}
	if track := bob.inspected(t); track.Mid != bob.mid || track.Subscription.State != protocol.SubscriptionActive {
		t.Fatalf("resumed subscription inspects as %+v", track.Subscription)
	}
	if bob.peer.pc.LocalDescription().SDP != bobSDP || len(bob.peer.pc.GetTransceivers()) != 1 {
		t.Fatal("pausing or resuming changed the viewer's session description")
	}
	assertContinuous(t, "carol", carol.received())
	assertContinuous(t, "bob", bob.received())

	// A NACK for a packet the SFU no longer holds asks the publisher for a
	// keyframe, because the lost packet may belong to a reference frame.
	time.Sleep(2 * keyframeInterval)
	asked := keyframeRequests.Load()
	latest := bob.received()[len(bob.received())-1]
	nack := &rtcp.TransportLayerNack{SenderSSRC: 1, MediaSSRC: latest.SSRC, Nacks: rtcp.NackPairsFromSequenceNumbers([]uint16{latest.SequenceNumber - 2000})}
	if err := bob.peer.pc.WriteRTCP([]rtcp.Packet{nack}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "a keyframe request for the lost packet", 2*time.Second, func() bool { return keyframeRequests.Load() > asked })
}

// startVP8Camera has a session publish a VP8 camera that sends one packet per frame and a
// keyframe every 15 frames, and ignores PLIs. It returns the session and the count of PLIs it got.
func startVP8Camera(t *testing.T, node *Node) (*Session, *atomic.Int64) {
	t.Helper()
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
	ctx, stop := context.WithCancel(context.Background())
	sending := make(chan struct{})
	t.Cleanup(func() { stop(); <-sending })
	go func() {
		defer close(sending)
		sendVP8Frames(ctx, camera)
	}()
	return publisher, &keyframeRequests
}

func sendVP8Frames(ctx context.Context, camera *webrtc.TrackLocalStaticRTP) {
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
}

// pullingViewer is a session that pulled the publisher's camera and records the packets it gets.
type pullingViewer struct {
	session *Session
	peer    *testPeer
	mid     string
	mu      sync.Mutex
	packets []*rtp.Packet
}

func joinViewer(t *testing.T, node *Node, publisher *Session, name string) *pullingViewer {
	t.Helper()
	v := &pullingViewer{session: node.newTestSession(t, testScope(name, 1)), peer: newTestPeer(t)}
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
	v.mid = pullAndAnswer(t, v.session, publisher, v.peer, "cam-0").Tracks[0].Mid
	return v
}

func (v *pullingViewer) received() []*rtp.Packet {
	v.mu.Lock()
	defer v.mu.Unlock()
	return append([]*rtp.Packet(nil), v.packets...)
}

func (v *pullingViewer) subscription() *subscription {
	v.session.mu.Lock()
	defer v.session.mu.Unlock()
	return v.session.subscribed[v.mid]
}

func (v *pullingViewer) inspected(t *testing.T) protocol.InspectedTrack {
	t.Helper()
	response, err := v.session.Inspect()
	if err != nil || len(response.Tracks) != 1 {
		t.Fatalf("inspect: %+v %v", response, err)
	}
	return response.Tracks[0]
}

func assertContinuous(t *testing.T, label string, packets []*rtp.Packet) {
	t.Helper()
	for i := 1; i < len(packets); i++ {
		if packets[i].SequenceNumber != packets[i-1].SequenceNumber+1 {
			t.Fatalf("%s: sequence went %d then %d", label, packets[i-1].SequenceNumber, packets[i].SequenceNumber)
		}
	}
}

// recordingWriter keeps the sequence numbers a subscriber was sent.
type recordingWriter struct{ sequences []uint16 }

func (r *recordingWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	r.sequences = append(r.sequences, header.SequenceNumber)
	return header.MarshalSize() + len(payload), nil
}

func (r *recordingWriter) Write(b []byte) (int, error) { return len(b), nil }
