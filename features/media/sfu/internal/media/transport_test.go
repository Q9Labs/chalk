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

func TestAudioIsNeverQueuedBehindVideo(t *testing.T) {
	transport, video, audio, wire := pacedTransport(t, 128<<10)
	var w packetWriter
	payload := make([]byte, 1000)
	transport.send(&egressPacket{binding: video, class: classVideo, seq: 1, payload: payload}, &w)
	transport.send(&egressPacket{binding: audio, class: classAudio, seq: 1, payload: payload[:80]}, &w)
	sent := wire.sent()
	if len(sent) != 1 || sent[0].ssrc != audio.ssrc {
		t.Fatalf("sent %+v, want only the audio packet while video waits", sent)
	}
	if transport.queues[classVideo].empty() {
		t.Fatal("the video packet is not queued")
	}
}

func TestQueuedPacketsLeaveRepairsFirstAndRecordTheirDelay(t *testing.T) {
	transport, video, _, wire := pacedTransport(t, 128<<10)
	var w packetWriter
	payload := make([]byte, 500)
	for seq := range uint16(3) {
		transport.send(&egressPacket{binding: video, class: classVideo, seq: 100 + seq, payload: payload}, &w)
	}
	transport.mu.Lock()
	transport.repair = 1e6 // the repair cap is not under test here
	transport.mu.Unlock()
	transport.send(&egressPacket{binding: video, class: classRepair, rtx: true, seq: 7, payload: payload}, &w)
	time.Sleep(20 * time.Millisecond)
	transport.mu.Lock()
	transport.tokens = 0
	transport.mu.Unlock()
	go transport.drain()
	transport.signal()
	deadline := time.Now().Add(2 * time.Second)
	for len(wire.sent()) < 4 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	sent := wire.sent()
	if len(sent) != 4 || sent[0].ssrc != video.rtxSSRC {
		t.Fatalf("sent %+v, want the repair first and then three video packets", sent)
	}
	for index := 1; index < len(sent); index++ {
		if sent[index].transportSeq != sent[index-1].transportSeq+1 {
			t.Fatalf("transport sequence numbers %+v are not consecutive", sent)
		}
	}
	counts := transport.delays.collect()
	if p95 := percentile(counts, 0.95); p95 < 20*time.Millisecond {
		t.Fatalf("queue delay p95 %v, want at least the 20 ms the packets waited", p95)
	}
}

func TestAFullPacerQueueDropsVideoAndReportsCongestion(t *testing.T) {
	transport, video, _, _ := pacedTransport(t, 4_000)
	var w packetWriter
	payload := make([]byte, 1000)
	for seq := range uint16(10) {
		transport.send(&egressPacket{binding: video, class: classVideo, seq: seq, payload: payload}, &w)
	}
	if transport.queuedBytes > 4_000 {
		t.Fatalf("queue holds %d bytes over its 4,000-byte cap", transport.queuedBytes)
	}
	if transport.counters.Dropped == 0 {
		t.Fatal("no video was dropped")
	}
	if !transport.estimate(monotonic()).congested {
		t.Fatal("the allocator was not told about the drop")
	}
	if transport.estimate(monotonic()).congested {
		t.Fatal("one drop reads as congestion twice")
	}
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

func TestACopyOfAFeedbackReportIsReadOnce(t *testing.T) {
	transport := newTransport(&delayHistogram{}, 128<<10, nil)
	t.Cleanup(transport.close)
	report := &rtcp.TransportLayerCC{FbPktCount: 4, BaseSequenceNumber: 1, PacketStatusCount: 1,
		PacketChunks: []rtcp.PacketStatusChunk{&rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketNotReceived, RunLength: 1}}}
	transport.onFeedback(report)
	transport.onFeedback(report)
	if transport.counters.Feedback != 1 {
		t.Fatalf("read %d copies of one report", transport.counters.Feedback)
	}
}

func TestFeedbackAboutAnotherStreamIsIgnored(t *testing.T) {
	pub, layers, _ := benchPublication(t)
	viewer := (*pub.subscribers.Load())[0] // forwards "h" on SSRC 100
	for _, layer := range layers {
		layer.lastAsked.Store(monotonic()) // the bench has no peer connection to send a PLI on
	}
	wire := &wireWriter{}
	binding := viewer.track.binding.Load()
	binding.writer = wire
	var header rtp.Header
	writer := &packetWriter{}
	for _, raw := range cameraPackets("h")[:20] {
		pub.forward(layers[0], raw, false, &header, writer)
	}
	before := len(wire.sent())
	if before == 0 {
		t.Fatal("nothing was forwarded")
	}
	lost := wire.sent()[5].seq
	nack := func(ssrc uint32) []rtcp.Packet {
		return []rtcp.Packet{&rtcp.TransportLayerNack{MediaSSRC: ssrc, Nacks: rtcp.NackPairsFromSequenceNumbers([]uint16{lost})}}
	}
	viewer.handleFeedback(nack(binding.ssrc+50), writer)
	if after := len(wire.sent()); after != before {
		t.Fatalf("a NACK for another stream resent %d packets", after-before)
	}
	viewer.handleFeedback(nack(binding.ssrc), writer)
	sent := wire.sent()
	if len(sent) != before+1 || sent[len(sent)-1].seq != lost {
		t.Fatalf("a NACK for this stream sent %+v, want packet %d again", sent[before:], lost)
	}
	viewer.handleFeedback(nack(binding.ssrc), writer)
	if again := len(wire.sent()); again != before+1 {
		t.Fatal("a second NACK within a round trip resent the packet again")
	}
}

func TestAQueueThatNeverEmptiesKeepsOnlyWhatItHolds(t *testing.T) {
	var q packetQueue
	q.push(queuedPacket{})
	for range 10_000 {
		q.push(queuedPacket{})
		q.pop()
	}
	if c := cap(q.items); c > 8 {
		t.Fatalf("a queue holding one packet grew to capacity %d after 10,000 pushes", c)
	}
}

func TestPacketsWithoutTransportFeedbackAreCountedAndTheirRepairsCapped(t *testing.T) {
	transport := newTransport(&delayHistogram{}, 128<<10, nil)
	t.Cleanup(transport.close)
	wire := &wireWriter{}
	video := &egressBinding{writer: wire, ssrc: 10, payloadType: 96, rtxSSRC: 11, rtxPayloadType: 97}
	audio := &egressBinding{writer: wire, ssrc: 20, payloadType: 111}
	var w packetWriter
	payload := make([]byte, 1000)
	transport.send(&egressPacket{binding: audio, class: classAudio, seq: 1, payload: payload[:80]}, &w)
	for seq := range uint16(200) {
		transport.send(&egressPacket{binding: video, class: classRepair, rtx: true, seq: seq, payload: payload}, &w)
	}
	if audio := transport.meters[classAudio].packets.Load(); audio != 1 {
		t.Fatalf("the audio meter counted %d packets, want 1", audio)
	}
	repairs := transport.meters[classRepair].packets.Load()
	if repairs == 0 || transport.counters.RepairsCut == 0 || repairs+transport.counters.RepairsCut != 200 {
		t.Fatalf("%d repairs counted and %d cut of 200, want both and all accounted", repairs, transport.counters.RepairsCut)
	}
	if sent := len(wire.sent()); uint64(sent) != 1+repairs {
		t.Fatalf("%d packets on the wire, want the audio and %d repairs", sent, repairs)
	}
}
