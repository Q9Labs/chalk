package tests

// Publisher and fixture support for the live runs: a Participant that sends simulcast cameras,
// a microphone and a screen from the IVF fixtures.

import (
	"cmp"
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	cameraName = "cam"
	micName    = "mic"
	screenName = "screen"
	micRate    = 50 // packets/s
)

var cameraPull = protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}

// participant is one Participant: one session and one peer connection that
// publishes and receives, behind its own link.
type participant struct {
	name  string
	scope protocol.Scope
	conn  string
	peer  *peer
	link  *link
	sent  atomic.Int64 // RTP packets published
	// screen is the screen publisher, when the participant shares one, so a
	// test can stop and resume it as a browser's share does.
	screen *simulcastPublisher
}

// publishing is what one participant sends.
type publishing struct {
	cameras int // simulcast cameras, named cam, cam2, cam3…
	screen  bool
	chunks  [2]int // camera payload bytes per packet of h and l
	// frameBytes pads each frame of the camera's h and l and of the screen to
	// at least this size, so the fixtures can carry a browser's bitrate. Padded
	// frames keep their headers but no longer decode. Zero keeps the fixture.
	frameBytes [3]int
	// screenChunk is the screen's payload bytes per packet; 0 is 160.
	screenChunk int
}

// cameraTrack names a participant's camera by its index.
func cameraTrack(index int) string {
	if index == 0 {
		return cameraName
	}
	return fmt.Sprintf("%s%d", cameraName, index+1)
}

// publish pushes the participant's sources and starts sending until the test ends.
func (p *participant) publish(t *testing.T, svc *service, what publishing) {
	t.Helper()
	high, low := readIVF(t, "high.ivf"), readIVF(t, "low.ivf")
	var tracks []protocol.Track
	type sender struct {
		publisher *simulcastPublisher
		rtp       *webrtc.RTPSender
	}
	var video []sender
	for index := range what.cameras {
		camera := &simulcastPublisher{fixtures: [2]layerFixture{{rid: "h", frames: high}, {rid: "l", frames: low}}, enabled: [2]bool{true, true}, chunks: what.chunks,
			frameBytes: [2]int{what.frameBytes[0], what.frameBytes[1]}, sent: &p.sent}
		for layer, fixture := range camera.fixtures {
			track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, cameraTrack(index), p.name, webrtc.WithRTPStreamID(fixture.rid))
			if err != nil {
				t.Fatal(err)
			}
			camera.tracks[layer] = track
		}
		rtpSender, err := p.peer.pc.AddTrack(camera.tracks[0])
		if err != nil {
			t.Fatal(err)
		}
		if err := rtpSender.AddEncoding(camera.tracks[1]); err != nil {
			t.Fatal(err)
		}
		video = append(video, sender{camera, rtpSender})
	}
	if what.screen {
		screen := &simulcastPublisher{fixtures: [2]layerFixture{{frames: high}}, enabled: [2]bool{true}, chunks: [2]int{cmp.Or(what.screenChunk, 160)},
			frameBytes: [2]int{what.frameBytes[2]}, sent: &p.sent}
		p.screen = screen
		track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, screenName, p.name)
		if err != nil {
			t.Fatal(err)
		}
		screen.tracks[0] = track
		rtpSender, err := p.peer.pc.AddTrack(track)
		if err != nil {
			t.Fatal(err)
		}
		video = append(video, sender{screen, rtpSender})
	}
	mic, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, micName, p.name)
	if err != nil {
		t.Fatal(err)
	}
	micSender, err := p.peer.pc.AddTrack(mic)
	if err != nil {
		t.Fatal(err)
	}

	offer, err := p.peer.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	pushOffer := p.peer.complete(t, offer)
	for _, v := range video {
		v.publisher.mid = p.peer.mid(t, v.publisher.tracks[0])
		source, name := "camera", v.publisher.tracks[0].ID()
		if v.publisher.tracks[1] == nil {
			source = "screen"
		}
		tracks = append(tracks, protocol.Track{Location: protocol.LocationLocal, Mid: v.publisher.mid, TrackName: name, Source: source})
	}
	tracks = append(tracks, protocol.Track{Location: protocol.LocationLocal, Mid: p.peer.mid(t, mic), TrackName: micName, Source: "microphone"})
	var pushed protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+p.conn+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: p.scope, SessionDescription: &pushOffer, Tracks: tracks}, &pushed)
	if pushed.SessionDescription == nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("%s push response: %+v", p.name, pushed)
	}
	if err := p.peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}

	ctx, stop := context.WithCancel(context.Background())
	var sending sync.WaitGroup
	t.Cleanup(func() { stop(); sending.Wait() })
	for _, v := range video {
		v.publisher.midID = extensionID(t, v.rtp, sdp.SDESMidURI)
		if v.publisher.tracks[1] != nil {
			v.publisher.ridID = extensionID(t, v.rtp, sdp.SDESRTPStreamIDURI)
		}
		v.publisher.run(ctx, &sending)
	}
	sending.Go(func() { sendMic(ctx, mic, &p.sent) })
	// Pion's interceptors answer NACKs only for RTCP someone reads, as a
	// browser always does. ReadRTCP reads the first encoding; each further
	// simulcast encoding has its own RTCP stream.
	readers := []*webrtc.RTPSender{micSender}
	for _, v := range video {
		readers = append(readers, v.rtp)
	}
	for _, rtpSender := range readers {
		go drainRTCP(func() error { _, _, err := rtpSender.ReadRTCP(); return err })
		for _, encoding := range rtpSender.GetParameters().Encodings[1:] {
			go drainRTCP(func() error { _, _, err := rtpSender.ReadSimulcastRTCP(encoding.RID); return err })
		}
	}
}

func drainRTCP(read func() error) {
	for read() == nil {
	}
}

func sendMic(ctx context.Context, track *webrtc.TrackLocalStaticRTP, sent *atomic.Int64) {
	ticker := time.NewTicker(time.Second / micRate)
	defer ticker.Stop()
	for index := 0; ; index++ {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		packet := &rtp.Packet{
			Header:  rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: uint16(index), Timestamp: uint32(index * 960), Marker: true},
			Payload: make([]byte, 80),
		}
		if err := track.WriteRTP(packet); err != nil {
			return
		}
		sent.Add(1)
	}
}

// pull subscribes the participant to the given remote tracks and answers the SFU's offer.
func (p *participant) pull(t *testing.T, svc *service, tracks []protocol.Track) {
	t.Helper()
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+p.conn+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: p.scope, Tracks: tracks}, &pulled)
	if pulled.SessionDescription == nil || len(pulled.TrackErrors) != 0 {
		t.Fatalf("%s pull response: %+v", p.name, pulled)
	}
	if err := p.peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := p.peer.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	answerSDP := p.peer.complete(t, answer)
	svc.mustCall(t, "/v1/sessions/"+p.conn+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: p.scope, SessionDescription: answerSDP}, nil)
}

func remote(publisher *participant, name string) protocol.Track {
	track := protocol.Track{Location: protocol.LocationRemote, SessionID: publisher.conn, TrackName: name}
	if strings.HasPrefix(name, cameraName) {
		pull := cameraPull
		track.Simulcast = &pull
	}
	return track
}

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
