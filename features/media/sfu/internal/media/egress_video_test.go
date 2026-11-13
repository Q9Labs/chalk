package media

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// videoRecorder stands in for the batched UDP writer: it records the SSRCs the egress track marks as video.
type videoRecorder struct {
	mu     sync.Mutex
	marked map[uint32]bool
}

func (r *videoRecorder) markVideo(ssrc uint32, on bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if on {
		r.marked[ssrc] = true
	} else {
		delete(r.marked, ssrc)
	}
}

func (r *videoRecorder) has(ssrc uint32) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.marked[ssrc]
}

// pushCamera grants the participant's camera source and publishes one camera track for it.
func pushCamera(t *testing.T, node *Node, name string, session *Session, peer *testPeer) {
	t.Helper()
	apply(t, node, control(name, "camera", protocol.SourceGrant, 1))
	camera, err := webrtc.NewTrackLocalStaticRTP(vp8Capability, "cam", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := peer.pc.AddTrack(camera); err != nil {
		t.Fatal(err)
	}
	pushed, err := pushAll(t, session, peer, "cam", "camera")
	if err != nil || len(pushed.Tracks) != 1 {
		t.Fatalf("push: %+v %v", pushed, err)
	}
	if err := peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
}

// A Firefox viewer's offer names VP8 as 120 and RTX as 124, so the node's video to it carries types
// the node never offers. The writer can only tell it from audio by SSRC, so the egress track marks
// the media and RTX SSRCs it was bound to, and unmarks them when it is unbound.
func TestEgressMarksTheVideoSSRCsOfAFirefoxNumberedViewer(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	pushCamera(t, node, "alice", publisher, newTestPeer(t))

	// The viewer's own offer comes first, so its payload types are the ones the node uses to it.
	firefoxVP8 := webrtc.RTPCodecParameters{RTPCodecCapability: vp8Capability, PayloadType: 120}
	firefoxRTX := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeRTX, ClockRate: 90000, SDPFmtpLine: "apt=120"},
		PayloadType:        124,
	}
	viewer := node.newTestSession(t, testScope("bob", 1))
	viewerPeer := newTestPeer(t, firefoxVP8, firefoxRTX)
	pushCamera(t, node, "bob", viewer, viewerPeer)

	pulled, err := viewer.AddTracks(context.Background(), pullRequest(viewer, publisher, "cam-0"))
	if err != nil || len(pulled.Tracks) != 1 {
		t.Fatalf("pull: %+v %v", pulled, err)
	}
	writer := &videoRecorder{marked: map[uint32]bool{}}
	viewer.mu.Lock()
	track := viewer.subscribed[pulled.Tracks[0].Mid].track
	track.video = writer // before the answer, which is what starts the track
	viewer.mu.Unlock()
	answer := protocol.RenegotiateRequest{OperationID: op(), SessionDescription: viewerPeer.answer(t, pulled.SessionDescription)}
	if err := viewer.Renegotiate(context.Background(), answer); err != nil {
		t.Fatal(err)
	}
	var binding *egressBinding
	eventually(t, "the pulled track to bind", 10*time.Second, func() bool {
		binding = track.binding.Load()
		return binding != nil
	})
	if binding.payloadType != 120 || binding.rtxPayloadType != 124 || binding.rtxSSRC == 0 {
		t.Fatalf("the viewer was bound to VP8 %d and RTX %d (RTX SSRC %d), want the types its offer named: 120 and 124", binding.payloadType, binding.rtxPayloadType, binding.rtxSSRC)
	}
	if !writer.has(binding.ssrc) || !writer.has(binding.rtxSSRC) {
		t.Fatalf("the writer was told of SSRCs %v, want the media SSRC %d and the RTX SSRC %d", writer.marked, binding.ssrc, binding.rtxSSRC)
	}
	if err := track.Unbind(nil); err != nil {
		t.Fatal(err)
	}
	if writer.has(binding.ssrc) || writer.has(binding.rtxSSRC) {
		t.Fatalf("the writer still treats SSRCs %v as video after the track unbound", writer.marked)
	}
}
