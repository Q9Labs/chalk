package tests

import (
	"bytes"
	"cmp"
	"context"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// The fixtures are real libvpx VP8 at 30 frames a second: "h" is 320x180 with
// one keyframe in 30 frames, "l" is 160x90 with one in 10. They were made with:
//
//	ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30 -c:v libvpx -deadline realtime -cpu-used 8 \
//	  -auto-alt-ref 0 -lag-in-frames 0 -error-resilient 1 -frames:v 30 -g 30 -b:v 250k high.ivf
//	ffmpeg -f lavfi -i testsrc2=size=160x90:rate=30 ... -g 10 -b:v 80k low.ivf
const (
	frameTicks  = 90000 / 30
	vp8Chunk    = 300 // payload bytes per packet, so every frame spans several packets
	vp8DescSize = 5   // X|S, I|L, 15-bit picture ID, TL0PICIDX
)

type layerFixture struct {
	rid    string
	frames [][]byte
}

var scopeE = protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "erin", Generation: 1}

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
	seq := uint16(65500 - 100*layer)
	timestamp := uint32(0xFFFFFFFF - 20*frameTicks)
	pictureID := uint16(0x7FF0) // the 15-bit picture ID wraps too
	tl0 := uint8(250)
	for frame := 0; ; frame++ {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		// A disabled layer is an encoder that stopped: its clock and counters
		// run on, and it resumes mid-GOP.
		data := fixture.frames[frame%len(fixture.frames)]
		var packets []*rtp.Packet
		for start := 0; start < len(data); start += chunk {
			end := min(start+chunk, len(data))
			descriptor := []byte{0x80, 0xC0, 0x80 | byte(pictureID>>8), byte(pictureID), tl0}
			if start == 0 {
				descriptor[0] |= 0x10
			}
			packet := &rtp.Packet{
				Header:  rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: seq, Timestamp: timestamp, Marker: end == len(data)},
				Payload: append(descriptor, data[start:end]...),
			}
			_ = packet.Header.SetExtension(p.midID, []byte(p.mid))
			if p.ridID != 0 {
				_ = packet.Header.SetExtension(p.ridID, []byte(fixture.rid))
			}
			packets = append(packets, packet)
			seq++
		}
		if len(packets) > 1 && (keyframe(data) || frame%3 == 0) {
			packets[0], packets[1] = packets[1], packets[0]
		}
		if p.on(layer) {
			for _, packet := range packets {
				if err := p.tracks[layer].WriteRTP(packet); err != nil {
					return
				}
				if p.sent != nil {
					p.sent.Add(1)
				}
			}
		}
		timestamp += frameTicks
		pictureID = (pictureID + 1) & 0x7FFF
		tl0++
	}
}

// padFrames returns the frames with zeros appended to at least size bytes.
func padFrames(frames [][]byte, size int) [][]byte {
	padded := make([][]byte, len(frames))
	for index, frame := range frames {
		padded[index] = append(slices.Clone(frame), make([]byte, max(0, size-len(frame)))...)
	}
	return padded
}

// videoReceiver keeps every video packet one subscriber receives, and the
// subscriber's track to send feedback about.
type videoReceiver struct {
	peer    *peer
	mu      sync.Mutex
	packets []*rtp.Packet
	ssrc    uint32
	readers sync.WaitGroup
}

func collectVideo(p *peer) *videoReceiver {
	r := &videoReceiver{peer: p}
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if remote.Kind() != webrtc.RTPCodecTypeVideo {
			return
		}
		r.mu.Lock()
		r.ssrc = uint32(remote.SSRC())
		r.mu.Unlock()
		r.readers.Go(func() {
			for {
				packet, _, err := remote.ReadRTP()
				if err != nil {
					return
				}
				r.mu.Lock()
				r.packets = append(r.packets, packet)
				r.mu.Unlock()
			}
		})
	})
	return r
}

func (r *videoReceiver) snapshot() []*rtp.Packet {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*rtp.Packet(nil), r.packets...)
}

func (r *videoReceiver) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.packets)
}

// receivedFrame is one frame put back together from a subscriber's packets.
type receivedFrame struct {
	layer, index int // which fixture frame it is
	timestamp    uint32
	pictureID    uint16
	tl0          uint8
	data         []byte
	// incompleteBefore counts the frames whose start arrived since the previous
	// complete frame but which never completed. A switch cuts the old layer's
	// frame short that way, and each such frame still used a picture ID.
	incompleteBefore int
}

// reassemble rebuilds a subscriber's frames the way a receiver's jitter buffer
// does: in sequence order, a frame runs from a packet that starts it to one
// with the marker, with no sequence missing and one timestamp. A frame that
// breaks that is dropped, as a receiver would drop it; assertDecodable then
// fails if a later frame needed it. Every complete frame must be a fixture
// frame byte for byte, and a retransmission must repeat the original exactly.
func reassemble(t *testing.T, label string, packets []*rtp.Packet, fixtures [2]layerFixture) (frames []receivedFrame, dropped int) {
	t.Helper()
	known := map[string][2]int{}
	for layer, fixture := range fixtures {
		for index, frame := range fixture.frames {
			known[string(frame)] = [2]int{layer, index}
		}
	}
	bySeq := map[int64]*rtp.Packet{}
	var highest, lowest int64
	for position, packet := range packets {
		ext := int64(packet.SequenceNumber)
		if position > 0 {
			ext = highest + int64(int16(packet.SequenceNumber-uint16(highest)))
		}
		if position == 0 || ext > highest {
			highest = ext
		}
		if position == 0 || ext < lowest {
			lowest = ext
		}
		if earlier, ok := bySeq[ext]; ok {
			if earlier.Timestamp != packet.Timestamp || !bytes.Equal(earlier.Payload, packet.Payload) {
				t.Fatalf("%s: sequence %d arrived twice with different content", label, packet.SequenceNumber)
			}
			continue
		}
		bySeq[ext] = packet
	}
	var first *rtp.Packet
	var data []byte
	incomplete := 0
	for ext := lowest; ext <= highest; ext++ {
		packet, ok := bySeq[ext]
		if first != nil && (!ok || packet.Timestamp != first.Timestamp || packet.Payload[0]&0x10 != 0) {
			first, data = nil, nil
			dropped++
			incomplete++
		}
		if !ok {
			continue
		}
		if first == nil {
			if packet.Payload[0]&0x10 == 0 {
				continue
			}
			first = packet
		}
		data = append(data, packet.Payload[vp8DescSize:]...)
		if !packet.Marker {
			continue
		}
		where, ok := known[string(data)]
		if !ok {
			t.Fatalf("%s: frame %d (%d bytes) is not a fixture frame", label, len(frames), len(data))
		}
		frames = append(frames, receivedFrame{
			layer: where[0], index: where[1], timestamp: first.Timestamp, data: data,
			pictureID: uint16(first.Payload[2]&0x7F)<<8 | uint16(first.Payload[3]), tl0: first.Payload[4],
			incompleteBefore: incomplete,
		})
		first, data, incomplete = nil, nil, 0
	}
	return frames, dropped
}

// assertDecodable checks what a decoder needs: every frame is a keyframe or
// the next frame of the same layer, so no frame references one the subscriber
// never got. The timestamp, picture ID and TL0PICIDX must advance across
// every switch and pause. It returns how often the layer changed.
func assertDecodable(t *testing.T, label string, frames []receivedFrame, fixtures [2]layerFixture) int {
	t.Helper()
	if len(frames) == 0 {
		t.Fatalf("%s: no frames", label)
	}
	switches := 0
	for i, frame := range frames {
		rid := fixtures[frame.layer].rid
		key := keyframe(fixtures[frame.layer].frames[frame.index])
		if i == 0 {
			if !key {
				t.Fatalf("%s: the stream starts on a delta frame of %q", label, rid)
			}
			continue
		}
		previous := frames[i-1]
		follows := frame.layer == previous.layer && frame.index == (previous.index+1)%len(fixtures[frame.layer].frames)
		if !key && !follows {
			t.Fatalf("%s: delta frame %d of %q follows frame %d of %q, so its reference is missing",
				label, frame.index, rid, previous.index, fixtures[previous.layer].rid)
		}
		if frame.layer != previous.layer {
			switches++
		}
		if delta := int32(frame.timestamp - previous.timestamp); delta <= 0 {
			t.Fatalf("%s: timestamp went %d then %d", label, previous.timestamp, frame.timestamp)
		}
		step := 1 + frame.incompleteBefore
		if frame.pictureID != (previous.pictureID+uint16(step))&0x7FFF {
			t.Fatalf("%s: picture ID went %d then %d with %d incomplete frames between", label, previous.pictureID, frame.pictureID, frame.incompleteBefore)
		}
		if frame.tl0 != previous.tl0+uint8(step) {
			t.Fatalf("%s: TL0PICIDX went %d then %d with %d incomplete frames between", label, previous.tl0, frame.tl0, frame.incompleteBefore)
		}
	}
	return switches
}

// decodeWithFFmpeg writes the frames as one IVF file and decodes it, when
// ffmpeg is installed. A decoder error fails the test.
func decodeWithFFmpeg(t *testing.T, label string, frames []receivedFrame) {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Logf("%s: ffmpeg not installed; skipped the decode", label)
		return
	}
	var file bytes.Buffer
	header := make([]byte, 32)
	copy(header, "DKIF")
	binary.LittleEndian.PutUint16(header[6:], 32)
	copy(header[8:], "VP80")
	binary.LittleEndian.PutUint16(header[12:], 320)
	binary.LittleEndian.PutUint16(header[14:], 180)
	binary.LittleEndian.PutUint32(header[16:], 30)
	binary.LittleEndian.PutUint32(header[20:], 1)
	binary.LittleEndian.PutUint32(header[24:], uint32(len(frames)))
	file.Write(header)
	for index, frame := range frames {
		var prefix [12]byte
		binary.LittleEndian.PutUint32(prefix[:], uint32(len(frame.data)))
		binary.LittleEndian.PutUint64(prefix[4:], uint64(index))
		file.Write(prefix[:])
		file.Write(frame.data)
	}
	path := filepath.Join(t.TempDir(), label+".ivf")
	if err := os.WriteFile(path, file.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(ffmpeg, "-hide_banner", "-v", "error", "-xerror", "-i", path, "-f", "null", "-").CombinedOutput()
	if err != nil || len(bytes.TrimSpace(output)) > 0 {
		t.Fatalf("%s: ffmpeg could not decode the forwarded stream: %v %s", label, err, output)
	}
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

// pullVideo subscribes a new peer to the camera and answers the SFU's offer.
func pullVideo(t *testing.T, svc *service, connID string, scope protocol.Scope, publisher string, simulcast protocol.Simulcast) *videoReceiver {
	t.Helper()
	// The NACK check asks again for packets the subscriber already has, which
	// SRTP replay protection would discard; a real loss never reached it.
	subscriber := newPeer(t, func(settings *webrtc.SettingEngine) { settings.DisableSRTPReplayProtection(true) })
	received := collectVideo(subscriber)
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+connID+"/tracks", protocol.TracksRequest{OperationID: op(),
		Scope:  scope,
		Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: publisher, TrackName: videoName, Simulcast: &simulcast}},
	}, &pulled)
	if pulled.SessionDescription == nil || len(pulled.TrackErrors) != 0 {
		t.Fatalf("pull response: %+v", pulled)
	}
	if err := subscriber.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := subscriber.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	answerSDP := subscriber.complete(t, answer)
	svc.mustCall(t, "/v1/sessions/"+connID+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: scope, SessionDescription: answerSDP}, nil)
	return received
}

func subscriptionState(t *testing.T, svc *service, connID string, scope protocol.Scope) protocol.SubscriptionState {
	t.Helper()
	for _, track := range svc.inspect(t, connID, scope) {
		if track.TrackName == videoName && track.Subscription != nil {
			return *track.Subscription
		}
	}
	return protocol.SubscriptionState{}
}

// TestLayerSwitching publishes real VP8 as two simulcast layers and switches
// subscribers between them as the publisher stops and restarts each layer.
// Every forwarded stream must decode: each switch lands on a keyframe, and
// sequence numbers, timestamps and picture IDs continue across it.
func TestLayerSwitching(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	t.Cleanup(svc.stop)
	svc.grantSources(t, scopeA)
	fixtures := [2]layerFixture{{rid: "h", frames: readIVF(t, "high.ivf")}, {rid: "l", frames: readIVF(t, "low.ivf")}}

	connA := svc.createSession(t, "create-alice", scopeA)
	alice := newPeer(t)
	publisher := &simulcastPublisher{fixtures: fixtures, enabled: [2]bool{true, true}}
	for layer, fixture := range fixtures {
		track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", "alice", webrtc.WithRTPStreamID(fixture.rid))
		if err != nil {
			t.Fatal(err)
		}
		publisher.tracks[layer] = track
	}
	sender, err := alice.pc.AddTrack(publisher.tracks[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := sender.AddEncoding(publisher.tracks[1]); err != nil {
		t.Fatal(err)
	}
	offer, err := alice.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	pushOffer := alice.complete(t, offer)
	publisher.mid = alice.mid(t, publisher.tracks[0])
	var pushed protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+connA+"/tracks", protocol.TracksRequest{OperationID: op(),
		Scope: scopeA, SessionDescription: &pushOffer,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: publisher.mid, TrackName: videoName, Source: "camera"}},
	}, &pushed)
	if pushed.SessionDescription == nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push response: %+v", pushed)
	}
	if err := alice.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	publisher.midID = extensionID(t, sender, sdp.SDESMidURI)
	publisher.ridID = extensionID(t, sender, sdp.SDESRTPStreamIDURI)

	ctx, stop := context.WithCancel(context.Background())
	var sending sync.WaitGroup
	publisher.run(ctx, &sending)
	t.Cleanup(func() { stop(); sending.Wait() })
	eventually(t, "both layers active", 10*time.Second, func() bool {
		tracks := svc.inspect(t, connA, scopeA)
		return len(tracks) == 1 && len(tracks[0].Layers) == 2 && tracks[0].Layers[0].Active && tracks[0].Layers[1].Active
	})

	// bob wants "h" and erin wants "l", both falling back in ASCII order;
	// dave wants "h" with no fallback, so he pauses while it is off.
	connB, connC, connD := svc.createSession(t, "create-bob", scopeB), svc.createSession(t, "create-erin", scopeE), svc.createSession(t, "create-dave", scopeD)
	bob := pullVideo(t, svc, connB, scopeB, connA, protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"})
	erin := pullVideo(t, svc, connC, scopeE, connA, protocol.Simulcast{PreferredRID: "l", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"})
	dave := pullVideo(t, svc, connD, scopeD, connA, protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "none"})

	expect := func(phase string, bobRID, erinRID string, davePaused bool) {
		t.Helper()
		eventually(t, phase, 10*time.Second, func() bool {
			b, c, d := subscriptionState(t, svc, connB, scopeB), subscriptionState(t, svc, connC, scopeE), subscriptionState(t, svc, connD, scopeD)
			daveOK := d.State == protocol.SubscriptionActive && d.EffectiveRID == "h"
			if davePaused {
				daveOK = d.State == protocol.SubscriptionPaused && d.Reason == protocol.PauseSourceInactive
			}
			return b.EffectiveRID == bobRID && c.EffectiveRID == erinRID && daveOK
		})
		time.Sleep(400 * time.Millisecond) // forward a few frames on the new layers
	}
	expect("bob on h, erin on l", "h", "l", false)
	for range 2 {
		publisher.enable(0, false)
		expect("h stopped: bob falls back to l, dave pauses", "l", "l", true)
		daveBefore := dave.count()
		time.Sleep(300 * time.Millisecond)
		if dave.count() != daveBefore {
			t.Fatal("dave kept receiving video while paused")
		}
		publisher.enable(0, true)
		expect("h resumed: bob and dave return to h", "h", "l", false)
		publisher.enable(1, false)
		expect("l stopped: erin falls back to h", "h", "h", false)
		publisher.enable(1, true)
		expect("l resumed: erin returns to l", "h", "l", false)
	}

	t.Run("a NACK repeats the packet each subscriber received", func(t *testing.T) {
		for _, subscriber := range []struct {
			label    string
			received *videoReceiver
		}{{"bob", bob}, {"erin", erin}} {
			packets := subscriber.received.snapshot()
			target := packets[len(packets)-5]
			before := len(packets)
			subscriber.received.mu.Lock()
			ssrc := subscriber.received.ssrc
			subscriber.received.mu.Unlock()
			if err := subscriber.received.peer.pc.WriteRTCP([]rtcp.Packet{&rtcp.TransportLayerNack{
				MediaSSRC: ssrc, Nacks: []rtcp.NackPair{{PacketID: target.SequenceNumber}},
			}}); err != nil {
				t.Fatal(err)
			}
			eventually(t, subscriber.label+"'s retransmission", 5*time.Second, func() bool {
				for _, packet := range subscriber.received.snapshot()[before:] {
					if packet.SequenceNumber == target.SequenceNumber {
						if packet.Timestamp != target.Timestamp || !bytes.Equal(packet.Payload, target.Payload) {
							t.Fatalf("%s: retransmission of %d differs from the original", subscriber.label, target.SequenceNumber)
						}
						return true
					}
				}
				return false
			})
		}
	})

	stop()
	sending.Wait()
	time.Sleep(200 * time.Millisecond) // packets in flight
	for _, subscriber := range []struct {
		label    string
		received *videoReceiver
		switches int
	}{{"bob", bob, 4}, {"erin", erin, 4}, {"dave", dave, 0}} {
		frames, dropped := reassemble(t, subscriber.label, subscriber.received.snapshot(), fixtures)
		switches := assertDecodable(t, subscriber.label, frames, fixtures)
		if switches < subscriber.switches {
			t.Fatalf("%s switched layers %d times, want at least %d", subscriber.label, switches, subscriber.switches)
		}
		decodeWithFFmpeg(t, subscriber.label, frames)
		t.Logf("%s: %d frames decodable, %d switches, %d partial frames dropped", subscriber.label, len(frames), switches, dropped)
	}
}
