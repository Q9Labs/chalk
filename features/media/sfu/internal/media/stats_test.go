package media

import (
	"strconv"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// audioPublication is a microphone with one layer, no session and no subscriber.
func audioPublication() (*publication, *ingressLayer) {
	pub := &publication{kind: webrtc.RTPCodecTypeAudio, source: "microphone", done: make(chan struct{}), authority: freeAuthority()}
	layer := &ingressLayer{clockRate: 48_000}
	layer.lastRTP.Store(monotonic())
	pub.layers[0].Store(layer)
	return pub, layer
}

func audioPacket(t *testing.T, seq uint16, timestamp uint32) []byte {
	t.Helper()
	raw, err := (&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: timestamp, SSRC: 7}, Payload: make([]byte, 80)}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// A gap in sequence numbers is loss until a repair fills it, a mute is not loss, and jitter
// follows the spread of arrival times against the sender's clock.
func TestIngressCountersSeeLossRepairJitterAndHold(t *testing.T) {
	pub, layer := audioPublication()
	var header rtp.Header
	writer := &packetWriter{}
	send := func(seq uint16, repaired bool) {
		pub.forward(layer, audioPacket(t, seq, uint32(seq)*960), repaired, &header, writer)
	}
	for seq := uint16(100); seq < 110; seq++ {
		send(seq, false)
	}
	if stats := pub.ingressStats(monotonic()); stats.lost != 0 || stats.packets != 10 || stats.layers != 1 {
		t.Fatalf("clean stream = %+v", stats)
	}
	send(112, false) // 110 and 111 never arrive
	if stats := pub.ingressStats(monotonic()); stats.lost != 2 {
		t.Fatalf("lost = %d, want 2", stats.lost)
	}
	send(110, true)
	stats := pub.ingressStats(monotonic())
	if stats.lost != 1 || stats.repaired != 1 {
		t.Fatalf("after one repair: lost %d repaired %d, want 1 and 1", stats.lost, stats.repaired)
	}

	pub.held.Store(true)
	for seq := uint16(113); seq < 143; seq++ {
		send(seq, false)
	}
	pub.held.Store(false)
	send(143, false)
	if stats := pub.ingressStats(monotonic()); stats.lost != 1 {
		t.Fatalf("a mute counted as loss: lost = %d, want 1", stats.lost)
	}
	if jitter := pub.ingressStats(monotonic()).jitterMs; jitter < 0 {
		t.Fatalf("jitter = %v", jitter)
	}
}

func TestIngressJitterIsZeroForSteadyArrivalsAndGrowsWithSpread(t *testing.T) {
	layer := &ingressLayer{clockRate: 48_000}
	at := int64(0)
	for seq := range 40 {
		at += int64(20 * time.Millisecond)
		layer.arrived(1<<16+uint64(seq), uint32(seq)*960, at, false)
	}
	if steady := layer.jitterTicks; steady > 1e-6 {
		t.Fatalf("steady 20 ms arrivals have jitter %v ticks", steady)
	}
	for seq := 40; seq < 80; seq++ {
		spread := int64(0)
		if seq%2 == 0 {
			spread = int64(10 * time.Millisecond)
		}
		layer.arrived(1<<16+uint64(seq), uint32(seq)*960, int64(seq)*int64(20*time.Millisecond)+spread, false)
	}
	if layer.jitterTicks < 100 {
		t.Fatalf("10 ms of spread (480 ticks) gave jitter %v ticks", layer.jitterTicks)
	}
}

// A receiver report answers the sender report it names, and the round trip is the time since that
// report less the receiver's hold.
func TestReceiverReportYieldsRoundTripJitterAndLoss(t *testing.T) {
	now := time.Unix(1_700_000_000, 250_000_000)
	seconds := uint64(now.Unix()) + ntpEpochOffset
	fraction := uint64(now.Nanosecond()) << 32 / uint64(time.Second)
	compact := uint32((seconds<<32 | fraction) >> 16)
	sent := compact - uint32(80*65536/1000) // the sender report left 80 ms ago
	var f feedbackStats
	f.report(rtcp.ReceptionReport{TotalLost: 12, FractionLost: 64, Jitter: 480, LastSenderReport: sent, Delay: uint32(30 * 65536 / 1000)}, now)
	rtt := time.Duration(f.rtt.Load())
	if rtt < 48*time.Millisecond || rtt > 52*time.Millisecond {
		t.Fatalf("rtt = %v, want about 50ms", rtt)
	}
	if f.lost.Load() != 12 || f.jitter.Load() != 480 || f.fraction.Load() != 64 {
		t.Fatalf("report fields = %d %d %d", f.lost.Load(), f.jitter.Load(), f.fraction.Load())
	}
	if _, ok := receiverRTT(now, 0, 0); ok {
		t.Fatal("a report that answers no sender report has a round trip")
	}
	if _, ok := receiverRTT(now, compact+65536, 0); ok {
		t.Fatal("a sender report from the future has a round trip")
	}
	nack := &rtcp.TransportLayerNack{Nacks: []rtcp.NackPair{{PacketID: 10, LostPackets: 0b101}, {PacketID: 40}}}
	if got := nacked(nack); got != 4 {
		t.Fatalf("nacked = %d, want 4", got)
	}
}

func TestMediaEventsFollowTheConnectedSession(t *testing.T) {
	trail := &trailLog{}
	node := newLoggedTestNode(t, nil, trail)
	alice := node.newTestSession(t, testScope("alice", 1))
	bob := node.newTestSession(t, testScope("bob", 2))
	publish(t, alice, "mic", 1)

	node.traceMedia()
	if got := len(trail.events(EventMediaIngress)) + len(trail.events(EventMediaTransport)); got != 0 {
		t.Fatalf("sessions that never connected wrote %d media events", got)
	}

	alice.onConnectionState(webrtc.PeerConnectionStateConnected)
	bob.onConnectionState(webrtc.PeerConnectionStateConnected)
	node.traceMedia()
	ingress := trail.events(EventMediaIngress)
	if len(ingress) != 1 || ingress[0]["source"] != "microphone" || ingress[0]["media_kind"] != "audio" || ingress[0]["mid"] == "" || ingress[0]["final"] != "false" {
		t.Fatalf("ingress events = %v", ingress)
	}
	requireIDs(t, ingress[0], alice.scope)
	for _, field := range []string{"packets", "bytes", "lost", "jitter_ms", "bitrate_bps", "nack_requested", "pli_sent", "layers"} {
		if _, ok := ingress[0][field]; !ok {
			t.Errorf("ingress event lacks %s: %v", field, ingress[0])
		}
	}
	transport := trail.events(EventMediaTransport)
	if len(transport) != 2 || transport[0]["estimate_bps"] == "" || transport[0]["connection_id"] == "" {
		t.Fatalf("transport events = %v", transport)
	}

	// A track that sends nothing writes one event to show the silence, then none.
	node.traceMedia()
	node.traceMedia()
	if got := len(trail.events(EventMediaIngress)); got != 1 {
		t.Fatalf("a flat counter wrote %d ingress events in three intervals, want 1", got)
	}

	alice.CloseFor(CloseEpisodeEnded)
	last := trail.events(EventMediaIngress)
	if final := last[len(last)-1]; final["final"] != "true" {
		t.Fatalf("the close wrote no final counters: %v", final)
	}
	if finalTransport := trail.events(EventMediaTransport); finalTransport[len(finalTransport)-1]["final"] != "true" {
		t.Fatalf("the close wrote no final transport counters")
	}
	if _, err := strconv.Atoi(last[len(last)-1]["packets"]); err != nil {
		t.Fatalf("packets is not a number: %v", err)
	}
}

// Every field a media event writes is exportable: the contract names it, with a source.
func TestMediaEventFieldsAreInTheExportContract(t *testing.T) {
	for _, event := range []string{EventMediaIngress, EventMediaEgress, EventMediaTransport, EventControlFailed, EventNegotiationFailed, EventSessionClosed} {
		for _, field := range EventFields[event] {
			if _, ok := FieldSources[field]; !ok {
				t.Errorf("%s exports %s, which has no source", event, field)
			}
		}
	}
}
