package tests

import (
	"cmp"
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type layerFixture struct {
	rid    string
	frames [][]byte
}

func readIVF(t *testing.T, name string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 32 || string(data[:4]) != "DKIF" {
		t.Fatalf("%s is not IVF", name)
	}
	var frames [][]byte
	for rest := data[binary.LittleEndian.Uint16(data[6:8]):]; len(rest) >= 12; {
		size := int(binary.LittleEndian.Uint32(rest[:4]))
		frames = append(frames, rest[12:12+size])
		rest = rest[12+size:]
	}
	return frames
}

func keyframe(frame []byte) bool { return frame[0]&0x01 == 0 }

// simulcastPublisher sends the two fixtures as one simulcast camera, with the
// MID and RID header extensions a browser stamps. Each layer starts its
// sequence numbers and timestamps just before they wrap, reorders packets in
// every frame and puts each keyframe's first packet second, and ignores
// keyframe requests, so a switch waits for the layer's next natural keyframe.
type simulcastPublisher struct {
	tracks     [2]*webrtc.TrackLocalStaticRTP // a single-encoding source leaves the second nil
	fixtures   [2]layerFixture
	midID      uint8
	ridID      uint8 // 0 for a single-encoding source
	mid        string
	chunks     [2]int        // payload bytes per packet of each layer; 0 is vp8Chunk
	frameBytes [2]int        // pads each layer's frames to at least this size; 0 keeps them
	sent       *atomic.Int64 // counts every packet written, when set

	mu      sync.Mutex
	enabled [2]bool
}

func (p *simulcastPublisher) enable(layer int, on bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.enabled[layer] = on
}

func (p *simulcastPublisher) on(layer int) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.enabled[layer]
}

func (p *simulcastPublisher) run(ctx context.Context, done *sync.WaitGroup) {
	for layer, track := range p.tracks {
		if track != nil {
			done.Go(func() { p.send(ctx, layer) })
		}
	}
}

func (p *simulcastPublisher) send(ctx context.Context, layer int) {
	ticker := time.NewTicker(time.Second / 30)
	defer ticker.Stop()
	fixture := p.fixtures[layer]
	if size := p.frameBytes[layer]; size > 0 {
		fixture.frames = padFrames(fixture.frames, size)
	}
	chunk := cmp.Or(p.chunks[layer], vp8Chunk)
	counters := frameCounters{
		seq:       uint16(65500 - 100*layer),
		timestamp: uint32(0xFFFFFFFF - 20*frameTicks),
		pictureID: 0x7FF0, // the 15-bit picture ID wraps too
		tl0:       250,
	}
	for frame := 0; ; frame++ {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		// A disabled layer is an encoder that stopped: its clock and counters
		// run on, and it resumes mid-GOP.
		data := fixture.frames[frame%len(fixture.frames)]
		packets := p.framePackets(fixture.rid, data, chunk, &counters)
		if len(packets) > 1 && (keyframe(data) || frame%3 == 0) {
			packets[0], packets[1] = packets[1], packets[0]
		}
		if p.on(layer) && !p.write(layer, packets) {
			return
		}
		counters.timestamp += frameTicks
		counters.pictureID = (counters.pictureID + 1) & 0x7FFF
		counters.tl0++
	}
}

// frameCounters are the sequence number, timestamp and VP8 picture counters a layer's frames carry.
type frameCounters struct {
	seq       uint16
	timestamp uint32
	pictureID uint16
	tl0       uint8
}

// framePackets cuts one frame into packets of at most chunk payload bytes, advancing the sequence number.
func (p *simulcastPublisher) framePackets(rid string, data []byte, chunk int, c *frameCounters) []*rtp.Packet {
	var packets []*rtp.Packet
	for start := 0; start < len(data); start += chunk {
		end := min(start+chunk, len(data))
		descriptor := []byte{0x80, 0xC0, 0x80 | byte(c.pictureID>>8), byte(c.pictureID), c.tl0}
		if start == 0 {
			descriptor[0] |= 0x10
		}
		packet := &rtp.Packet{
			Header:  rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: c.seq, Timestamp: c.timestamp, Marker: end == len(data)},
			Payload: append(descriptor, data[start:end]...),
		}
		_ = packet.Header.SetExtension(p.midID, []byte(p.mid))
		if p.ridID != 0 {
			_ = packet.Header.SetExtension(p.ridID, []byte(rid))
		}
		packets = append(packets, packet)
		c.seq++
	}
	return packets
}

// write sends a frame's packets on the layer and reports false once the track is closed.
func (p *simulcastPublisher) write(layer int, packets []*rtp.Packet) bool {
	for _, packet := range packets {
		if err := p.tracks[layer].WriteRTP(packet); err != nil {
			return false
		}
		if p.sent != nil {
			p.sent.Add(1)
		}
	}
	return true
}

// padFrames returns the frames with zeros appended to at least size bytes.
func padFrames(frames [][]byte, size int) [][]byte {
	padded := make([][]byte, len(frames))
	for index, frame := range frames {
		padded[index] = append(slices.Clone(frame), make([]byte, max(0, size-len(frame)))...)
	}
	return padded
}

func extensionID(t *testing.T, sender *webrtc.RTPSender, uri string) uint8 {
	t.Helper()
	for _, extension := range sender.GetParameters().HeaderExtensions {
		if extension.URI == uri {
			return uint8(extension.ID)
		}
	}
	t.Fatalf("header extension %s was not negotiated", uri)
	return 0
}
