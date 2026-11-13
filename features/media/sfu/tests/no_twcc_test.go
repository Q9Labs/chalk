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

	alice := &participant{name: "alice", scope: scopeA, link: newLink(t)}
	alice.peer = newMediaPeer(t, alice.link, true)
	alice.conn = svc.createSession(t, "create-alice", scopeA)
	alice.publish(t, svc, publishing{cameras: 1, chunks: [2]int{1100, 1100}, frameBytes: [3]int{frameBytes(1500), frameBytes(300)}})

	bob := &participant{name: "bob", scope: scopeB, link: newLink(t)}
	bob.peer = newPeerThrough(t, bob.link, true, false)
	bob.conn = svc.createSession(t, "create-bob", scopeB)
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

// logDelivery records what the node forwards the viewer, so a stalled second names its cause.
func (c *noTWCCCall) logDelivery(t *testing.T, second, packets int) {
	t.Helper()
	var response protocol.InspectResponse
	c.svc.mustCall(t, "/v1/sessions/"+c.viewer.conn+"/inspect", protocol.InspectRequest{Scope: c.viewer.scope}, &response)
	dropped, _ := c.viewer.link.dropped()
	for _, track := range response.Tracks {
		if strings.HasPrefix(track.TrackName, cameraName) && track.Subscription != nil {
			t.Logf("second %d: %d video packets; camera %s %s layer %q; estimate %d bps, queued %d B, pacer dropped %d, link dropped %d",
				second, packets, track.Subscription.State, track.Subscription.Reason, track.Subscription.EffectiveRID,
				response.Transport.EstimateBps, response.Transport.QueuedBytes, response.Transport.Dropped, dropped)
		}
	}
}

// A viewer that sends no transport-wide feedback is still adapted: heavy loss in its receiver
// reports lowers its ceiling, the allocator moves its camera to the low layer, and media keeps
// flowing on a link that cannot carry the high one.
func TestViewerWithoutTWCCStepsDownOnALossyLink(t *testing.T) {
	call := startNoTWCCCall(t)
	eventually(t, "the camera starts on the high layer", 20*time.Second, func() bool { return call.cameraLayer(t) == "h" })
	call.viewer.link.shape(700_000, 20_000, 20*time.Millisecond, 0, 0)
	started := time.Now()
	eventually(t, "the camera steps down to the low layer", 30*time.Second, func() bool { return call.cameraLayer(t) == "l" })
	t.Logf("low layer after %s", time.Since(started).Round(100*time.Millisecond))

	for second := range 4 {
		before := call.received.count(webrtc.RTPCodecTypeVideo)
		time.Sleep(time.Second)
		got := call.received.count(webrtc.RTPCodecTypeVideo) - before
		call.logDelivery(t, second, got)
		if got < 10 {
			t.Fatalf("second %d after the step down carried %d video packets, want a flowing stream", second, got)
		}
	}
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
