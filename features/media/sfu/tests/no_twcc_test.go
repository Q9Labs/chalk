package tests

import (
	"strings"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// noTWCCCall is a publisher with a high and a low camera layer and a microphone, and a
// viewer whose peer offers no transport-wide feedback behind a link the test shapes.
type noTWCCCall struct {
	svc      *service
	viewer   *participant
	received *receiver
}

func startNoTWCCCall(t *testing.T) *noTWCCCall {
	t.Helper()
	svc := startService(t, newAuthority(t, "chalk test CA"))
	svc.grantSources(t, scopeA, scopeB)

	alice := newParticipant(t, svc, "alice", scopeA, true)
	alice.publish(t, svc, publishing{cameras: 1, chunks: [2]int{1100, 1100}, frameBytes: [3]int{frameBytes(1500), frameBytes(300)}})

	bob := newParticipant(t, svc, "bob", scopeB, false)
	received := collect(bob.peer)
	bob.pull(t, svc, []protocol.Track{remote(alice, micName), remote(alice, cameraName)})
	if sdp := bob.peer.pc.CurrentLocalDescription().SDP; strings.Contains(sdp, "transport-cc") || strings.Contains(sdp, "transport-wide-cc") {
		t.Fatalf("the viewer answered with transport-wide feedback:\n%s", sdp)
	}
	eventually(t, "audio and video reach the viewer", 20*time.Second, func() bool {
		return received.count(webrtc.RTPCodecTypeAudio) >= 30 && received.count(webrtc.RTPCodecTypeVideo) >= 30
	})
	return &noTWCCCall{svc: svc, viewer: bob, received: received}
}

// cameraLayer is the layer the node forwards to the viewer's camera.
func (c *noTWCCCall) cameraLayer(t *testing.T) string {
	t.Helper()
	for _, track := range c.svc.inspect(t, c.viewer.conn, c.viewer.scope) {
		if strings.HasPrefix(track.TrackName, cameraName) && track.Subscription != nil {
			return track.Subscription.EffectiveRID
		}
	}
	return ""
}

// A viewer that sends REMB is held to what it asks for, on a link with no loss at all.
func TestViewerWithoutTWCCFollowsItsREMB(t *testing.T) {
	call := startNoTWCCCall(t)
	var ssrc uint32
	for _, receiver := range call.viewer.peer.pc.GetReceivers() {
		if track := receiver.Track(); track != nil && track.Kind() == webrtc.RTPCodecTypeVideo {
			ssrc = uint32(track.SSRC())
		}
	}
	if ssrc == 0 {
		t.Fatal("the viewer has no video receiver")
	}
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		tick := time.NewTicker(200 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				_ = call.viewer.peer.pc.WriteRTCP([]rtcp.Packet{&rtcp.ReceiverEstimatedMaximumBitrate{SenderSSRC: 1, Bitrate: 600_000, SSRCs: []uint32{ssrc}}})
			}
		}
	}()
	eventually(t, "the camera follows a 600 kbps REMB down to the low layer", 20*time.Second, func() bool { return call.cameraLayer(t) == "l" })
	time.Sleep(3 * time.Second)
	if layer := call.cameraLayer(t); layer != "l" {
		t.Fatalf("the camera is on layer %q three seconds later, want it to stay on l", layer)
	}
}
