package media

import (
	"encoding/binary"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
)

// wireWriter records what a transport put on the wire.
type wireWriter struct {
	mu      sync.Mutex
	packets []wirePacket
}

type wirePacket struct {
	ssrc         uint32
	seq          uint16
	transportSeq uint16
	payloadSize  int
}

func (w *wireWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	packet := wirePacket{ssrc: header.SSRC, seq: header.SequenceNumber, payloadSize: len(payload)}
	if extension := header.GetExtension(3); len(extension) == 2 {
		packet.transportSeq = binary.BigEndian.Uint16(extension)
	}
	w.mu.Lock()
	w.packets = append(w.packets, packet)
	w.mu.Unlock()
	return header.MarshalSize() + len(payload), nil
}

func (w *wireWriter) Write(b []byte) (int, error) { return len(b), nil }

func (w *wireWriter) sent() []wirePacket {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.packets)
}

// pacedTransport is a transport whose pacer has no tokens left, so the next
// video packet must wait.
func pacedTransport(t *testing.T, queueBytes int) (*transport, *egressBinding, *egressBinding, *wireWriter) {
	t.Helper()
	transport := newTransport(&delayHistogram{}, queueBytes, nil)
	t.Cleanup(transport.close)
	wire := &wireWriter{}
	video := &egressBinding{writer: wire, ssrc: 10, payloadType: 96, rtxSSRC: 11, rtxPayloadType: 97, twccID: 3}
	audio := &egressBinding{writer: wire, ssrc: 20, payloadType: 111, twccID: 3}
	transport.mu.Lock()
	transport.refill(monotonic())
	transport.tokens = -1e6
	transport.mu.Unlock()
	return transport, video, audio, wire
}

func TestRepairsAreCappedAtAShareOfTheRate(t *testing.T) {
	transport, video, _, wire := pacedTransport(t, 128<<10)
	transport.mu.Lock()
	transport.tokens = 1e9 // pacing is not under test here
	transport.mu.Unlock()
	var w packetWriter
	payload := make([]byte, 1000)
	for seq := range uint16(200) {
		transport.send(&egressPacket{binding: video, class: classRepair, rtx: true, seq: seq, payload: payload}, &w)
	}
	// The cap is a quarter of the proven rate, at least 100 kbit/s, with a 100 ms burst.
	burst := transport.repairRate / 8 * repairBurst.Seconds()
	if sent := len(wire.sent()); float64(sent*1024) > 1.1*burst || sent == 0 {
		t.Fatalf("%d repairs went out at once, the burst allows %.0f bytes", sent, burst)
	}
	if transport.counters.RepairsCut == 0 {
		t.Fatal("no repair was cut")
	}
}

func TestWalkFeedbackReadsEveryChunkKind(t *testing.T) {
	var log [sendLogSize]sentPacket
	for seq := range uint16(8) {
		log[seq] = sentPacket{seq: seq, valid: true, size: 100, sent: int64(seq) * int64(time.Millisecond)}
	}
	report := &rtcp.TransportLayerCC{
		BaseSequenceNumber: 0, PacketStatusCount: 8, ReferenceTime: 10,
		PacketChunks: []rtcp.PacketStatusChunk{
			&rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketReceivedSmallDelta, RunLength: 3},
			&rtcp.StatusVectorChunk{SymbolSize: rtcp.TypeTCCSymbolSizeTwoBit, SymbolList: []uint16{
				rtcp.TypeTCCPacketNotReceived, rtcp.TypeTCCPacketReceivedLargeDelta, rtcp.TypeTCCPacketNotReceived,
				rtcp.TypeTCCPacketReceivedSmallDelta, rtcp.TypeTCCPacketReceivedSmallDelta, rtcp.TypeTCCPacketNotReceived,
				rtcp.TypeTCCPacketNotReceived,
			}},
		},
		RecvDeltas: []*rtcp.RecvDelta{
			{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 1000},
			{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 1000},
			{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 1000},
			{Type: rtcp.TypeTCCPacketReceivedLargeDelta, Delta: -500},
			{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 2000},
			{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 250},
		},
	}
	acks := walkFeedback(report, log[:], nil)
	received := []bool{true, true, true, false, true, false, true, true}
	if len(acks) != len(received) {
		t.Fatalf("%d acknowledgments, want 8 (the status count, not the chunk capacity)", len(acks))
	}
	base := int64(10) * int64(64*time.Millisecond)
	arrivals := []int64{1000, 2000, 3000, 0, 2500, 0, 4500, 4750}
	for index, ack := range acks {
		if ack.received != received[index] {
			t.Fatalf("ack %d received %v, want %v", index, ack.received, received[index])
		}
		if ack.received && ack.arrival != base+arrivals[index]*int64(time.Microsecond) {
			t.Fatalf("ack %d arrived at %d, want %d", index, ack.arrival-base, arrivals[index]*int64(time.Microsecond))
		}
	}
	if again := walkFeedback(report, log[:], nil); len(again) != 0 {
		t.Fatalf("a repeated report acknowledged %d packets again", len(again))
	}
}

// probingTransport has a probe of target bits/s running since now.
func probingTransport(t *testing.T, target float64, now int64) *transport {
	t.Helper()
	transport, video, _, _ := pacedTransport(t, 128<<10)
	transport.bind(video)
	transport.mu.Lock()
	transport.tokens = 1e9
	transport.refilled = now
	transport.mu.Unlock()
	if !transport.probe(target, now) {
		t.Fatal("the probe did not start")
	}
	return transport
}

// After heavy loss ends, the next probe must not wait out the backoff the failed probes of the
// loss built: a paused tile resumes only on a probe's proof, so that wait is the video's dark time.
func TestAProbeIsDueAtOnceWhenHeavyLossEnds(t *testing.T) {
	transport := newTransport(&delayHistogram{}, 128<<10, nil)
	t.Cleanup(transport.close)
	feedback := func(count uint16, first uint16, status rtcp.PacketStatusChunk, deltas []*rtcp.RecvDelta) {
		transport.mu.Lock()
		for seq := first; seq < first+20; seq++ {
			transport.log[seq] = sentPacket{seq: seq, valid: true, size: 1000, sent: int64(seq) * int64(time.Millisecond)}
		}
		transport.mu.Unlock()
		transport.onFeedback(&rtcp.TransportLayerCC{FbPktCount: uint8(count), BaseSequenceNumber: first, PacketStatusCount: 20,
			PacketChunks: []rtcp.PacketStatusChunk{status}, RecvDeltas: deltas})
	}
	lost := &rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketNotReceived, RunLength: 20}
	feedback(1, 0, lost, nil)
	// The probes of the loss failed and doubled the backoff to its longest.
	transport.mu.Lock()
	transport.probeNext, transport.backoff = monotonic()+int64(probeBackoffMax), probeBackoffMax
	// Feedback that is late but still lossy is no sign that the loss ended, however long since the last heavy window.
	transport.estimator.lossAt = monotonic() - int64(3*time.Second)
	transport.mu.Unlock()
	feedback(2, 20, lost, nil)
	transport.mu.Lock()
	if transport.backoff != probeBackoffMax {
		t.Fatalf("the backoff is %v while the loss goes on", transport.backoff)
	}
	transport.mu.Unlock()

	deltas := make([]*rtcp.RecvDelta, 20)
	for index := range deltas {
		deltas[index] = &rtcp.RecvDelta{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 1000}
	}
	feedback(3, 40, &rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketReceivedSmallDelta, RunLength: 20}, deltas)
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.probeNext > monotonic() || transport.backoff != probeBackoffMin {
		t.Fatalf("the probe waits %v more and the backoff is %v after the loss ended", time.Duration(transport.probeNext-monotonic()), transport.backoff)
	}
}
