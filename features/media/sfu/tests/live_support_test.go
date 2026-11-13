package tests

// Publisher and fixture support for the live runs: a Participant that sends simulcast cameras,
// a microphone and a screen from the IVF fixtures.

import (
	"cmp"
	"context"
	"fmt"
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

// newParticipant creates a participant's session behind its own link. A client without
// transportWide offers no transport-wide feedback.
func newParticipant(t *testing.T, svc *service, name string, scope protocol.Scope, transportWide bool) *participant {
	t.Helper()
	p := &participant{name: name, scope: scope, link: newLink(t)}
	p.peer = newPeerThrough(t, p.link, true, transportWide)
	p.conn = svc.createSession(t, "create-"+name, scope)
	return p
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

// videoSender is one video source and the RTP sender that carries it.
type videoSender struct {
	publisher *simulcastPublisher
	rtp       *webrtc.RTPSender
}

// publish pushes the participant's sources and starts sending until the test ends.
func (p *participant) publish(t *testing.T, svc *service, what publishing) {
	t.Helper()
	high, low := readIVF(t, "high.ivf"), readIVF(t, "low.ivf")
	var video []videoSender
	for index := range what.cameras {
		video = append(video, p.addCamera(t, what, index, high, low))
	}
	if what.screen {
		video = append(video, p.addScreen(t, what, high))
	}
	mic := newLocalTrack(t, webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, micName, p.name)
	micSender, err := p.peer.pc.AddTrack(mic)
	if err != nil {
		t.Fatal(err)
	}

	offer, err := p.peer.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	pushOffer := p.peer.complete(t, offer)
	tracks := make([]protocol.Track, 0, len(video)+1)
	for _, v := range video {
		v.publisher.mid = p.peer.mid(t, v.publisher.tracks[0])
		source := "camera"
		if v.publisher.tracks[1] == nil {
			source = "screen"
		}
		tracks = append(tracks, protocol.Track{Location: protocol.LocationLocal, Mid: v.publisher.mid, TrackName: v.publisher.tracks[0].ID(), Source: source})
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
	p.startSending(t, video, mic, micSender)
}

// newLocalTrack makes a static RTP track of the participant's stream.
func newLocalTrack(t *testing.T, codec webrtc.RTPCodecCapability, id, stream string, options ...func(*webrtc.TrackLocalStaticRTP)) *webrtc.TrackLocalStaticRTP {
	track, err := webrtc.NewTrackLocalStaticRTP(codec, id, stream, options...)
	if err != nil {
		t.Fatal(err)
	}
	return track
}

var vp8Codec = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}

// addCamera adds the participant's index-th simulcast camera: an h and an l encoding.
func (p *participant) addCamera(t *testing.T, what publishing, index int, high, low [][]byte) videoSender {
	camera := &simulcastPublisher{fixtures: [2]layerFixture{{rid: "h", frames: high}, {rid: "l", frames: low}}, enabled: [2]bool{true, true}, chunks: what.chunks,
		frameBytes: [2]int{what.frameBytes[0], what.frameBytes[1]}, sent: &p.sent}
	for layer, fixture := range camera.fixtures {
		camera.tracks[layer] = newLocalTrack(t, vp8Codec, cameraTrack(index), p.name, webrtc.WithRTPStreamID(fixture.rid))
	}
	rtpSender, err := p.peer.pc.AddTrack(camera.tracks[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := rtpSender.AddEncoding(camera.tracks[1]); err != nil {
		t.Fatal(err)
	}
	return videoSender{camera, rtpSender}
}

// addScreen adds the participant's screen share, which has one encoding.
func (p *participant) addScreen(t *testing.T, what publishing, frames [][]byte) videoSender {
	screen := &simulcastPublisher{fixtures: [2]layerFixture{{frames: frames}}, enabled: [2]bool{true}, chunks: [2]int{cmp.Or(what.screenChunk, 160)},
		frameBytes: [2]int{what.frameBytes[2]}, sent: &p.sent}
	p.screen = screen
	screen.tracks[0] = newLocalTrack(t, vp8Codec, screenName, p.name)
	rtpSender, err := p.peer.pc.AddTrack(screen.tracks[0])
	if err != nil {
		t.Fatal(err)
	}
	return videoSender{screen, rtpSender}
}

// startSending sends the sources until the test ends and reads the senders' RTCP.
func (p *participant) startSending(t *testing.T, video []videoSender, mic *webrtc.TrackLocalStaticRTP, micSender *webrtc.RTPSender) {
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
	p.peer.answerOffer(t, svc, p.conn, p.scope, pulled.SessionDescription.SDP)
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
