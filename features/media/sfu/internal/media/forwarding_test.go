package media

import (
	"bytes"
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
	s := &subscription{pub: &publication{kind: webrtc.RTPCodecTypeVideo}, target: -1, revision: 1, translator: translator{clockRate: 90000}}
	views := []layerView{{rid: "h", active: true}, {rid: "l", active: true}}
	state := func() (string, uint64) {
		state, reason, revision, _, _ := s.state()
		return state + "/" + reason, revision
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
			Scope: session.scope, SessionDescription: offer,
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
				Scope: session.scope, SessionDescription: offer,
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
		if _, err := session.CloseTracks(context.Background(), protocol.CloseTracksRequest{Scope: session.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: peer.mids()[0]}}}); err != nil {
			t.Fatal(err)
		}
		again := push("mic-again")
		if len(again.Tracks) != 0 || len(again.TrackErrors) != 1 || again.TrackErrors[0].Code != protocol.TrackCodeInvalid {
			t.Fatalf("push on the closed MID: %+v", again)
		}
	})
}
