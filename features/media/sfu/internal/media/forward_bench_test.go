package media

import (
	"encoding/binary"
	"testing"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// The forwarding benchmarks compare M1's loop with the layer-aware path for
// one camera packet. Both write to the same no-op Pion writer, so the numbers
// leave out SRTP, interceptors and the socket, which cost the same in both.

const benchPacketsPerFrame = 5

// cameraPackets builds a ring of browser-like VP8 RTP packets: 1,100-byte
// payloads, MID and RID header extensions, a 15-bit picture ID and TL0PICIDX,
// and a keyframe every 30 frames.
func cameraPackets(rid string) [][]byte {
	packets := make([][]byte, 30*benchPacketsPerFrame)
	for i := range packets {
		frame := i / benchPacketsPerFrame
		start := i%benchPacketsPerFrame == 0
		descriptor := []byte{0x80, 0xC0, 0x80 | byte(frame>>8), byte(frame), byte(frame)}
		if start {
			descriptor[0] |= 0x10
		}
		payload := make([]byte, 1100)
		copy(payload, descriptor)
		payload[len(descriptor)] = 0x01
		if start && frame == 0 {
			payload[len(descriptor)] = 0x00
		}
		packet := rtp.Packet{Header: rtp.Header{
			Version: 2, PayloadType: 96, SequenceNumber: uint16(i), Timestamp: uint32(frame * 3000),
			Marker: i%benchPacketsPerFrame == benchPacketsPerFrame-1, SSRC: 1234,
		}, Payload: payload}
		_ = packet.Header.SetExtension(1, []byte("0"))
		_ = packet.Header.SetExtension(2, []byte(rid))
		raw, err := packet.Marshal()
		if err != nil {
			panic(err)
		}
		packets[i] = raw
	}
	return packets
}

// stamp gives packet n of the ring its place in an endless stream.
func stamp(raw []byte, n int) {
	frame := n / benchPacketsPerFrame
	binary.BigEndian.PutUint16(raw[2:], uint16(n))
	binary.BigEndian.PutUint32(raw[4:], uint32(frame*3000))
}

type discardWriter struct{ bytes int }

func (d *discardWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	d.bytes += header.MarshalSize() + len(payload)
	return header.MarshalSize() + len(payload), nil
}

func (d *discardWriter) Write(b []byte) (int, error) { d.bytes += len(b); return len(b), nil }

type benchContext struct {
	writer *discardWriter
	ssrc   webrtc.SSRC
}

func (c benchContext) CodecParameters() []webrtc.RTPCodecParameters {
	return []webrtc.RTPCodecParameters{{RTPCodecCapability: vp8Capability, PayloadType: 96}}
}
func (c benchContext) HeaderExtensions() []webrtc.RTPHeaderExtensionParameter { return nil }
func (c benchContext) SSRC() webrtc.SSRC                                      { return c.ssrc }
func (c benchContext) SSRCRetransmission() webrtc.SSRC                        { return 0 }
func (c benchContext) SSRCForwardErrorCorrection() webrtc.SSRC                { return 0 }
func (c benchContext) WriteStream() webrtc.TrackLocalWriter                   { return c.writer }
func (c benchContext) ID() string                                             { return "bench" }
func (c benchContext) RTCPReader() interceptor.RTCPReader                     { return nil }

// m1Forward is M1's loop body: Pion's ReadRTP allocates a receive buffer and
// a packet, and one shared static track writes to every subscriber.
func m1Forward(local *webrtc.TrackLocalStaticRTP, raw []byte) {
	buffer := make([]byte, 1460)
	n := copy(buffer, raw)
	packet := &rtp.Packet{}
	if err := packet.Unmarshal(buffer[:n]); err != nil {
		panic(err)
	}
	packet.Extension = false
	packet.Extensions = nil
	_ = local.WriteRTP(packet)
}

// benchPublication is a camera with layers "h" and "l", two subscribers
// forwarding "h" and one forwarding "l": a class of three, one camera's view.
func benchPublication(tb testing.TB) (*publication, [2]*ingressLayer, *discardWriter) {
	tb.Helper()
	pub := &publication{kind: webrtc.RTPCodecTypeVideo, source: "camera", done: make(chan struct{}), authority: freeAuthority()}
	var layers [2]*ingressLayer
	for index, rid := range []string{"h", "l"} {
		layers[index] = &ingressLayer{index: index, rid: rid, nack: &nackTracker{}}
		layers[index].history.Store(newHistory(historyBytes(testMemory, pub.kind, pub.source, rid), historySlots))
		layers[index].lastRTP.Store(monotonic())
		pub.layers[index].Store(layers[index])
	}
	writer := &discardWriter{}
	for index, rid := range []string{"h", "h", "l"} {
		track := &egressTrack{codec: vp8Capability, kind: pub.kind}
		track.binding.Store(&egressBinding{writer: writer, ssrc: uint32(100 + index), payloadType: 96})
		s := &subscription{pub: pub, track: track, request: layerRequest{ceiling: rid, fallback: true}, target: -1, revision: 1, translator: translator{clockRate: 90000}}
		pub.addSubscriber(s)
		views := pub.views(monotonic())
		s.reselect(views[:])
	}
	return pub, layers, writer
}

func BenchmarkForwardM1(b *testing.B) {
	local, err := webrtc.NewTrackLocalStaticRTP(vp8Capability, "cam", "alice")
	if err != nil {
		b.Fatal(err)
	}
	writer := &discardWriter{}
	for index := range 2 { // the two subscribers that want this layer
		if _, err := local.Bind(benchContext{writer: writer, ssrc: webrtc.SSRC(100 + index)}); err != nil {
			b.Fatal(err)
		}
	}
	packets := cameraPackets("h")
	b.ReportAllocs()
	b.SetBytes(1100)
	for n := 0; b.Loop(); n++ {
		raw := packets[n%len(packets)]
		stamp(raw, n)
		m1Forward(local, raw)
	}
}

func BenchmarkForwardLayers(b *testing.B) {
	pub, layers, _ := benchPublication(b)
	packets := cameraPackets("h")
	var header rtp.Header
	writer := &packetWriter{}
	b.ReportAllocs()
	b.SetBytes(1100)
	for n := 0; b.Loop(); n++ {
		raw := packets[n%len(packets)]
		stamp(raw, n)
		pub.forward(layers[0], raw, false, &header, writer)
	}
}

// TestForwardingAllocatesNothing keeps the per-packet path free of
// allocations, so forwarding never feeds the garbage collector.
func TestForwardingAllocatesNothing(t *testing.T) {
	pub, layers, sink := benchPublication(t)
	packets := cameraPackets("h")
	var header rtp.Header
	writer := &packetWriter{}
	n := 0
	allocs := testing.AllocsPerRun(1000, func() {
		raw := packets[n%len(packets)]
		stamp(raw, n)
		pub.forward(layers[0], raw, false, &header, writer)
		n++
	})
	if allocs != 0 {
		t.Fatalf("forwarding allocates %.2f times per packet", allocs)
	}
	if sink.bytes == 0 {
		t.Fatal("nothing was forwarded, so this proves nothing")
	}
}
