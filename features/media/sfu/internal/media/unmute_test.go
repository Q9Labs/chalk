package media

import (
	"strconv"
	"testing"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// voicedPacket is a microphone packet with an RFC 6464 level: below 50 is speech, 127 is silence.
func voicedPacket(t *testing.T, seq uint16, level byte) []byte {
	t.Helper()
	packet := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: uint32(seq) * 960, SSRC: 7}, Payload: make([]byte, 80)}
	if err := packet.Header.SetExtension(1, []byte{level}); err != nil {
		t.Fatal(err)
	}
	raw, err := packet.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// After each unmute the node stamps the first voiced packet and, for each subscription, when that
// packet went out. A packet in a mute, a silent packet and a later voiced one stamp nothing.
func TestUnmuteMilestonesFollowTheFirstVoicedPacket(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	alice := node.newTestSession(t, testScope("alice", 1))
	bob := node.newTestSession(t, testScope("bob", 2))
	pub, layer := audioPublication()
	pub.session = alice
	layer.audioLevelID = 1
	writer := &discardWriter{}
	transport := newTransport(&delayHistogram{}, testMemory.PacerQueueBytes, nil)
	transport.pace = 1e18
	track := &egressTrack{codec: vp8Capability, kind: pub.kind, transport: transport}
	track.binding.Store(&egressBinding{writer: writer, ssrc: 100, payloadType: 111})
	sub := &subscription{pub: pub, owner: bob, mid: "3", transport: transport, track: track, request: layerRequest{fallback: true}, target: -1, revision: 1, translator: translator{clockRate: 48_000}}
	pub.addSubscriber(sub)
	views := pub.views(monotonic())
	sub.reselect(views[:])

	var header rtp.Header
	scratch := &packetWriter{}
	seq := uint16(0)
	send := func(level byte) {
		seq++
		pub.forward(layer, voicedPacket(t, seq, level), false, &header, scratch)
	}

	send(20) // speech before any mute or unmute is no milestone
	for round := uint64(1); round <= 2; round++ {
		pub.setHeld(true)
		send(20) // speech into a mute goes nowhere
		pub.setHeld(false)
		send(127) // the room is silent
		send(30)  // the first voiced packet
		send(25)  // later speech adds nothing

		voiced := trail.events(EventUnmuteVoiced)
		forwarded := trail.events(EventUnmuteForwarded)
		if uint64(len(voiced)) != round || uint64(len(forwarded)) != round {
			t.Fatalf("round %d: %d voiced and %d forwarded milestones, want one of each per unmute", round, len(voiced), len(forwarded))
		}
		first, out := voiced[round-1], forwarded[round-1]
		if first["unmute_seq"] != strconv.FormatUint(round, 10) || out["unmute_seq"] != first["unmute_seq"] {
			t.Fatalf("round %d: the milestones disagree on the unmute: %v and %v", round, first, out)
		}
		requireIDs(t, first, alice.scope)
		requireIDs(t, out, bob.scope)
		if out["publisher_id"] != "alice" || out["mid"] != "3" || out["source"] != "microphone" || first["source"] != "microphone" {
			t.Fatalf("round %d: forwarded = %v", round, out)
		}
		sinceUnmute, err := strconv.ParseFloat(out["since_unmute_ms"], 64)
		if err != nil || sinceUnmute < 0 {
			t.Fatalf("round %d: since_unmute_ms = %q", round, out["since_unmute_ms"])
		}
		if sinceVoiced, err := strconv.ParseFloat(out["since_voiced_ms"], 64); err != nil || sinceVoiced < 0 || sinceVoiced > sinceUnmute {
			t.Fatalf("round %d: since_voiced_ms = %q, want within the %v ms since the unmute", round, out["since_voiced_ms"], sinceUnmute)
		}
	}

	held := trail.events(EventPublicationHeld)
	if len(held) != 4 || held[0]["held"] != "true" || held[1]["held"] != "false" || held[1]["unmute_seq"] != "1" || held[3]["unmute_seq"] != "2" {
		t.Fatalf("hold events = %v", held)
	}
	for _, event := range []string{EventPublicationHeld, EventUnmuteVoiced, EventUnmuteForwarded} {
		for _, field := range EventFields[event] {
			if _, ok := FieldSources[field]; !ok {
				t.Errorf("%s exports %s, which has no source", event, field)
			}
		}
	}
	for _, record := range append(trail.events(EventUnmuteVoiced), trail.events(EventUnmuteForwarded)...) {
		for _, forbidden := range []string{"level", "audio_level", "payload"} {
			if _, ok := record[forbidden]; ok {
				t.Errorf("a milestone carries %s: %v", forbidden, record)
			}
		}
	}
}

// A camera or screen share has no voice level, so its resume stamps nothing.
func TestOnlyAMicrophoneStampsAnUnmute(t *testing.T) {
	pub := &publication{kind: webrtc.RTPCodecTypeVideo, source: "camera", done: make(chan struct{}), authority: freeAuthority()}
	pub.setHeld(true)
	pub.setHeld(false)
	if pub.unmuting.Load() != nil {
		t.Fatal("a camera started an unmute watch")
	}
}
