package media

import (
	"context"
	"strings"
	"testing"

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
