package tests

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// The impairment harness runs the SFU against real Pion peers with the
// interceptors a browser has, NACK, RTX and transport-wide feedback, over
// emulated access links on real UDP.

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
	media *mediaReceiver
	sent  atomic.Int64 // RTP packets published
	// screen is the screen publisher, when the participant shares one, so a
	// test can stop and resume it as a browser's share does.
	screen *simulcastPublisher
}

func joinEpisode(t *testing.T, svc *service, episode, name string, keepVideo bool) *participant {
	t.Helper()
	return joinWith(t, svc, episode, name, keepVideo, true)
}

func joinWith(t *testing.T, svc *service, episode, name string, keepVideo, browserRTX bool) *participant {
	t.Helper()
	through := newLink(t)
	p := &participant{name: name, link: through, scope: protocol.Scope{TenantID: "tenant-1", EpisodeID: episode, ParticipantID: name, Generation: 1}}
	p.peer = newMediaPeer(t, through, browserRTX)
	p.media = receiveMedia(p.peer, keepVideo)
	p.conn = svc.createSession(t, op(), p.scope)
	svc.grantSources(t, p.scope)
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
	if pulled := p.pullSome(t, svc, tracks); len(pulled.TrackErrors) != 0 {
		t.Fatalf("%s pull response: %+v", p.name, pulled)
	}
}

// pullSome pulls tracks and negotiates the ones the node accepted; the caller reads the refusals.
func (p *participant) pullSome(t *testing.T, svc *service, tracks []protocol.Track) protocol.TracksResponse {
	t.Helper()
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+p.conn+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: p.scope, Tracks: tracks}, &pulled)
	if pulled.SessionDescription == nil {
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
	return pulled
}

func remote(publisher *participant, name string) protocol.Track {
	track := protocol.Track{Location: protocol.LocationRemote, SessionID: publisher.conn, TrackName: name}
	if strings.HasPrefix(name, cameraName) {
		pull := cameraPull
		track.Simulcast = &pull
	}
	return track
}

func (p *participant) inspect(t *testing.T, svc *service) protocol.InspectResponse {
	t.Helper()
	var response protocol.InspectResponse
	svc.mustCall(t, "/v1/sessions/"+p.conn+"/inspect", protocol.InspectRequest{Scope: p.scope}, &response)
	return response
}

// subscription finds the participant's subscription to a publisher's track.
func (p *participant) subscription(t *testing.T, svc *service, publisher *participant, name string) (protocol.InspectedTrack, protocol.InspectResponse) {
	t.Helper()
	response := p.inspect(t, svc)
	for _, track := range response.Tracks {
		if track.Location == protocol.LocationRemote && track.SessionID == publisher.conn && track.TrackName == name && track.Subscription != nil {
			return track, response
		}
	}
	return protocol.InspectedTrack{Subscription: &protocol.SubscriptionState{}}, response
}

// mediaReceiver counts every packet a peer receives per remote track, keeps
// microphone arrival times, and optionally keeps video packets for decoding.
type mediaReceiver struct {
	keepVideo bool
	packets   atomic.Int64

	mu      sync.Mutex
	video   map[string][]*rtp.Packet // by track key, when kept
	videoN  map[string]int
	repairs map[string]int // video packets that arrived over RTX
	audio   map[string][]time.Time
}

// trackKey names a remote track the way the SFU labels it: the publisher's
// connection ID and the track name.
func trackKey(publisher *participant, name string) string { return publisher.conn + "/" + name }

func receiveMedia(p *peer, keepVideo bool) *mediaReceiver {
	r := &mediaReceiver{keepVideo: keepVideo, video: map[string][]*rtp.Packet{}, videoN: map[string]int{}, repairs: map[string]int{}, audio: map[string][]time.Time{}}
	p.pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		key := track.StreamID() + "/" + track.ID()
		go func() {
			for {
				packet, attributes, err := track.ReadRTP()
				if err != nil {
					return
				}
				if len(packet.Payload) == 0 {
					continue
				} // Exclude bandwidth-probe padding from the ceiling proof.
				r.packets.Add(1)
				r.mu.Lock()
				if track.Kind() == webrtc.RTPCodecTypeAudio {
					r.audio[key] = append(r.audio[key], time.Now())
				} else {
					r.videoN[key]++
					if attributes.Get(webrtc.AttributeRtxSequenceNumber) != nil {
						r.repairs[key]++
					}
					if r.keepVideo {
						r.video[key] = append(r.video[key], packet)
					}
				}
				r.mu.Unlock()
			}
		}()
	})
	return r
}

func (r *mediaReceiver) videoCount(key string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.videoN[key]
}

func (r *mediaReceiver) videoPackets(key string) []*rtp.Packet {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.video[key])
}

func (r *mediaReceiver) repaired(key string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.repairs[key]
}

// audioBetween counts a track's microphone packets that arrived in [from, to)
// and the longest silence between them.
func (r *mediaReceiver) audioBetween(key string, from, to time.Time) (count int, longestGap time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	previous := from
	for _, at := range r.audio[key] {
		if at.Before(from) || !at.Before(to) {
			continue
		}
		count++
		longestGap = max(longestGap, at.Sub(previous))
		previous = at
	}
	return count, max(longestGap, to.Sub(previous))
}

// assertAudioFlows checks a microphone kept at least 90% of its rate over the
// window with no silence over 250 ms.
func assertAudioFlows(t *testing.T, label string, r *mediaReceiver, key string, from, to time.Time) {
	t.Helper()
	count, gap := r.audioBetween(key, from, to)
	want := 0.9 * micRate * to.Sub(from).Seconds()
	if float64(count) < want || gap > 250*time.Millisecond {
		t.Fatalf("%s: %d microphone packets in %v (want at least %.0f), longest silence %v", label, count, to.Sub(from).Round(time.Millisecond), want, gap)
	}
}

// TestOneConstrainedSubscriberAdaptsAlone constrains one of two subscribers'
// downlinks. A new pull starts on "l" and climbs to "h"; the constrained one
// drops to "l" while the other stays on "h" and its microphone keeps playing,
// rises again after recovery, pauses for congestion below the lowest layer
// without flapping through the SDK's seven-second stall window, and resumes
// only after the estimate has held.
func TestOneConstrainedSubscriberAdaptsAlone(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	alice := joinEpisode(t, svc, "episode-1", "alice", false)
	alice.publish(t, svc, publishing{cameras: 1})
	bob, carol := joinEpisode(t, svc, "episode-1", "bob", true), joinEpisode(t, svc, "episode-1", "carol", true)
	camera, mic := trackKey(alice, cameraName), trackKey(alice, micName)

	pulled := time.Now()
	trace(t, svc, carol, alice, cameraName)
	bob.pull(t, svc, []protocol.Track{remote(alice, cameraName), remote(alice, micName)})
	carol.pull(t, svc, []protocol.Track{remote(alice, cameraName), remote(alice, micName)})

	// A new pull starts on l and climbs to h on an unconstrained path.
	first := map[string]string{}
	reached := map[string]time.Duration{}
	eventually(t, "both subscribers on h", 15*time.Second, func() bool {
		for _, subscriber := range []*participant{bob, carol} {
			track, _ := subscriber.subscription(t, svc, alice, cameraName)
			rid := track.Subscription.EffectiveRID
			if first[subscriber.name] == "" && rid != "" {
				first[subscriber.name] = rid
			}
			if rid == "h" && reached[subscriber.name] == 0 {
				reached[subscriber.name] = time.Since(pulled)
			}
		}
		return reached["bob"] != 0 && reached["carol"] != 0
	})
	t.Logf("start: first layer bob %q carol %q; h after bob %v carol %v", first["bob"], first["carol"], reached["bob"].Round(time.Millisecond), reached["carol"].Round(time.Millisecond))
	if first["bob"] != "l" || first["carol"] != "l" {
		t.Fatalf("first forwarded layers bob %q carol %q, want l for both", first["bob"], first["carol"])
	}
	// The bound covers the allocator's climb, one probe retry, and the wait for
	// h's next keyframe: the replayed fixtures send one a second and ignore PLI.
	if worst := max(reached["bob"], reached["carol"]); worst > 6*time.Second {
		t.Fatalf("reached h after %v, want within 6 s", worst)
	}

	// bob must stay on h while only carol's downlink changes.
	var bobLeft atomic.Value
	watching, stopWatching := context.WithCancel(context.Background())
	var watcher sync.WaitGroup
	watcher.Go(func() {
		for watching.Err() == nil {
			track, _ := bob.subscription(t, svc, alice, cameraName)
			if state := track.Subscription; state.EffectiveRID != "h" && bobLeft.Load() == nil {
				bobLeft.Store(fmt.Sprintf("%+v", *state))
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	defer func() { stopWatching(); watcher.Wait() }()

	// Constrain carol between the layers. On the wire l is about 175 kbit/s, h
	// about 340 and the microphone about 50, so 300 kbit/s carries l and audio, not h.
	constrained := time.Now()
	carol.link.shape(300_000, 16_000, 20*time.Millisecond, 0, 0)
	eventually(t, "carol drops to l", 10*time.Second, func() bool {
		track, _ := carol.subscription(t, svc, alice, cameraName)
		return track.Subscription.EffectiveRID == "l"
	})
	dropped := time.Since(constrained)
	time.Sleep(time.Second) // the queue built before the drop drains
	settled := time.Now()
	time.Sleep(4 * time.Second)
	track, inspected := carol.subscription(t, svc, alice, cameraName)
	if track.Subscription.EffectiveRID != "l" {
		t.Fatalf("carol left l while constrained: %+v", *track.Subscription)
	}
	assertAudioFlows(t, "carol constrained", carol.media, mic, settled, time.Now())
	assertAudioFlows(t, "bob while carol is constrained", bob.media, mic, settled, time.Now())
	t.Logf("constrained to 300 kbit/s: carol on l after %v, estimate %d proven %d bit/s, feedback age %v ms",
		dropped.Round(time.Millisecond), inspected.Transport.EstimateBps, inspected.Transport.ProvenBps, deref(inspected.Transport.FeedbackAgeMs))

	// Recovery: the link opens and carol climbs back.
	recovered := time.Now()
	carol.link.shape(0, 0, 0, 0, 0)
	eventually(t, "carol back on h", 20*time.Second, func() bool {
		track, _ := carol.subscription(t, svc, alice, cameraName)
		return track.Subscription.EffectiveRID == "h"
	})
	t.Logf("recovery: carol on h %v after the link opened", time.Since(recovered).Round(time.Millisecond))

	// Below the lowest layer: 100 kbit/s carries the microphone but not l.
	const starvedRate, starvedQueue = 100_000, 12_000 // bits/s, bytes
	starved := time.Now()
	carol.link.shape(starvedRate, starvedQueue, 20*time.Millisecond, 0, 0)
	eventually(t, "carol paused for congestion", 10*time.Second, func() bool {
		track, _ := carol.subscription(t, svc, alice, cameraName)
		return track.Subscription.State == protocol.SubscriptionPaused && track.Subscription.Reason == protocol.PauseCongestion
	})
	paused := time.Since(starved)
	before, _ := carol.subscription(t, svc, alice, cameraName)
	time.Sleep(time.Second) // packets queued before the pause drain
	holdStart, videoBefore := time.Now(), carol.media.videoCount(camera)
	for time.Since(holdStart) < 8*time.Second {
		track, _ := carol.subscription(t, svc, alice, cameraName)
		if *track.Subscription != *before.Subscription || track.Mid != before.Mid {
			t.Fatalf("carol's paused subscription changed during the pause: %+v mid %s, was %+v mid %s",
				*track.Subscription, track.Mid, *before.Subscription, before.Mid)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if got := carol.media.videoCount(camera) - videoBefore; got > 0 {
		t.Fatalf("carol received %d video packets while paused", got)
	}
	assertAudioFlows(t, "carol paused", carol.media, mic, holdStart, time.Now())
	t.Logf("starved to 100 kbit/s: paused after %v; held paused with audio for 8 s at revision %d", paused.Round(time.Millisecond), before.Subscription.Revision)

	// Video returns only after the estimate holds.
	opened := time.Now()
	carol.link.shape(0, 0, 0, 0, 0)
	eventually(t, "carol's video resumes", 20*time.Second, func() bool {
		track, _ := carol.subscription(t, svc, alice, cameraName)
		return track.Subscription.State == protocol.SubscriptionActive && track.Subscription.EffectiveRID != ""
	})
	resumed := time.Since(opened)
	bound := resumeBound(starvedRate, starvedQueue)
	t.Logf("resume: carol's video back %v after the link opened, bound %v", resumed.Round(time.Millisecond), bound)
	if resumed < media.ResumeHold || resumed > bound {
		t.Fatalf("video resumed %v after the link opened, want between the %v resume hold and %v", resumed, media.ResumeHold, bound)
	}

	stopWatching()
	watcher.Wait()
	if left := bobLeft.Load(); left != nil {
		t.Fatalf("bob left h while only carol was constrained: %s", left)
	}
	fixtures := [2]layerFixture{{rid: "h", frames: readIVF(t, "high.ivf")}, {rid: "l", frames: readIVF(t, "low.ivf")}}
	frames, _ := reassemble(t, "bob", bob.media.videoPackets(camera), fixtures)
	assertDecodable(t, "bob", frames, fixtures)
	decodeWithFFmpeg(t, "bob", frames)
}

// resumeBound is the longest a congestion-paused subscription may take to
// resume once a starved link opens. Probes fail while the link is starved, and
// each failure doubles the wait. At worst, a probe that starts while the starved
// queue still drains fails too, then the longest backoff and the probe that
// proves the path run before the resume hold.
func resumeBound(rate float64, queueBytes int) time.Duration {
	drain := time.Duration(float64(queueBytes) * 8 * float64(time.Second) / rate)
	return drain + media.ProbeSettle + media.ProbeBackoffMax + media.ProbeSettle + media.ResumeHold + time.Second
}

// TestVideoOnlySubscriberResumesAfterStarvation pauses a subscriber that
// receives no audio, so once its video pauses only probe padding on the RTX
// SSRC reaches it, and its feedback names that SSRC. Its video must still
// resume when the link opens.
func TestVideoOnlySubscriberResumesAfterStarvation(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	alice := joinEpisode(t, svc, "episode-1", "alice", false)
	alice.publish(t, svc, publishing{cameras: 1})
	carol := joinEpisode(t, svc, "episode-1", "carol", false)
	carol.pull(t, svc, []protocol.Track{remote(alice, cameraName)})
	eventually(t, "carol receives video", 15*time.Second, func() bool {
		track, _ := carol.subscription(t, svc, alice, cameraName)
		return track.Subscription.State == protocol.SubscriptionActive && track.Subscription.EffectiveRID != ""
	})

	const starvedRate, starvedQueue = 100_000, 12_000 // bits/s, bytes; below the lowest layer
	carol.link.shape(starvedRate, starvedQueue, 20*time.Millisecond, 0, 0)
	eventually(t, "carol paused for congestion", 10*time.Second, func() bool {
		track, _ := carol.subscription(t, svc, alice, cameraName)
		return track.Subscription.State == protocol.SubscriptionPaused && track.Subscription.Reason == protocol.PauseCongestion
	})
	time.Sleep(2 * time.Second) // only probes reach carol now

	opened := time.Now()
	carol.link.shape(0, 0, 0, 0, 0)
	bound := resumeBound(starvedRate, starvedQueue)
	eventually(t, "carol's video resumes", bound+5*time.Second, func() bool {
		track, _ := carol.subscription(t, svc, alice, cameraName)
		return track.Subscription.State == protocol.SubscriptionActive && track.Subscription.EffectiveRID != ""
	})
	resumed := time.Since(opened)
	_, inspected := carol.subscription(t, svc, alice, cameraName)
	t.Logf("resume: video back %v after the link opened, bound %v; probes %d proved %d",
		resumed.Round(time.Millisecond), bound, inspected.Transport.Probes, inspected.Transport.ProvedProbe)
	if resumed < media.ResumeHold || resumed > bound {
		t.Fatalf("video resumed %v after the link opened, want between the %v resume hold and %v", resumed, media.ResumeHold, bound)
	}
}

func deref(value *int64) int64 {
	if value == nil {
		return -1
	}
	return *value
}

// TestLossOnEachLegIsRepairedOverRTX loses packets between the publisher and
// the SFU and between the SFU and the subscriber. Both legs must ask for the
// lost packets and get them back over RTX, so the subscriber's stream still
// decodes from start to end.
func TestLossOnEachLegIsRepairedOverRTX(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	alice := joinEpisode(t, svc, "episode-1", "alice", false)
	alice.publish(t, svc, publishing{cameras: 1, screen: true})
	bob := joinEpisode(t, svc, "episode-1", "bob", true)
	bob.pull(t, svc, []protocol.Track{remote(alice, cameraName), remote(alice, micName), remote(alice, screenName)})
	camera := trackKey(alice, cameraName)
	eventually(t, "bob receives video", 10*time.Second, func() bool { return bob.media.videoCount(camera) > 100 })

	alice.link.shape(0, 0, 0, 0, 0.03)
	bob.link.shape(0, 0, 10*time.Millisecond, 0.03, 0)
	time.Sleep(8 * time.Second)
	alice.link.shape(0, 0, 0, 0, 0)
	bob.link.shape(0, 0, 0, 0, 0)
	time.Sleep(time.Second) // the last repairs arrive

	_, uplinkLost := alice.link.dropped()
	downlinkLost, _ := bob.link.dropped()
	t.Logf("uplink: %d packets lost", uplinkLost)
	for _, track := range alice.inspect(t, svc).Tracks {
		for _, layer := range track.Layers {
			t.Logf("uplink %s %q: %d asked for again, %d repaired over RTX", track.TrackName, layer.RID, layer.RequestedPackets, layer.RepairedPackets)
			if layer.RequestedPackets == 0 || layer.RepairedPackets == 0 {
				t.Fatalf("uplink loss on %s %q: %d requested, %d repaired over RTX; want both above zero", track.TrackName, layer.RID, layer.RequestedPackets, layer.RepairedPackets)
			}
		}
	}
	_, inspected := bob.subscription(t, svc, alice, cameraName)
	repairedOut := bob.media.repaired(camera) + bob.media.repaired(trackKey(alice, screenName))
	t.Logf("downlink: %d packets lost, %d repairs sent, %d received over RTX, %d cut by the repair cap",
		downlinkLost, inspected.Transport.Sent.Repair, repairedOut, inspected.Transport.RepairsCut)
	if inspected.Transport.Sent.Repair == 0 || repairedOut == 0 {
		t.Fatalf("downlink loss: %d repairs sent, %d received over RTX; want both above zero", inspected.Transport.Sent.Repair, repairedOut)
	}

	fixtures := [2]layerFixture{{rid: "h", frames: readIVF(t, "high.ivf")}, {rid: "l", frames: readIVF(t, "low.ivf")}}
	frames, incomplete := reassemble(t, "bob", bob.media.videoPackets(camera), fixtures)
	assertDecodable(t, "bob", frames, fixtures)
	decodeWithFFmpeg(t, "bob", frames)
	t.Logf("bob: %d frames decodable, %d incomplete", len(frames), incomplete)
}

// TestAPublisherThatSendsRTXUnderItsRIDCannotHangShutdown uses Pion's own
// simulcast sender, which copies a layer's RID onto its RTX packets. Pion then
// binds the RTX stream as that layer and never closes the layer's first
// stream, so the layer's reader never returns. Stopping the service must still
// finish, and say why it waited.
func TestAPublisherThatSendsRTXUnderItsRIDCannotHangShutdown(t *testing.T) {
	if raceDetector {
		// Pion v4.2.26 rebinds the layer in receiveForRid while the SFU's reader
		// is inside TrackRemote.Read, without a lock, so the race detector fails
		// this shape inside Pion. It needs a Pion patch.
		t.Skip("Pion's RID rebind races with the layer's reader")
	}
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	alice := joinWith(t, svc, "episode-1", "alice", false, false)
	alice.publish(t, svc, publishing{cameras: 1})
	alice.link.shape(0, 0, 0, 0, 0.05)
	time.Sleep(3 * time.Second) // the SFU asks for lost packets and alice answers over RTX

	stopped := make(chan time.Duration, 1)
	start := time.Now()
	go func() {
		svc.stop()
		stopped <- time.Since(start)
	}()
	select {
	case took := <-stopped:
		t.Logf("the service stopped in %v", took.Round(time.Millisecond))
	case <-time.After(15 * time.Second):
		t.Fatal("stopping the service hung on a layer reader")
	}
	if !strings.Contains(svc.logs.String(), "media readers still running after close") {
		t.Fatal("the service stopped without an orphaned reader, so the test proved nothing; Pion's sender may name its RTX differently now")
	}
}

// TestTenPersonCallWithAScreenShareStaysUnderTheEpisodeCeiling runs the rare
// shape: ten Participants, every camera at a high packet rate, one screen
// share, everyone receiving everything. The Episode must stay at or below
// 11,520 packets/s, ingress and egress with repair, without losing audio.
func TestTenPersonCallWithAScreenShareStaysUnderTheEpisodeCeiling(t *testing.T) {
	if testing.Short() {
		t.Skip("runs twenty real peer connections")
	}
	const ceiling = 11_520
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) {
		cfg.PacketBudget, cfg.EpisodePacketCeiling = 16_000, ceiling
		cfg.MaxSessions, cfg.MaxSubscriptionsPerSession = 16, 24
	})
	people := make([]*participant, 10)
	for index := range people {
		people[index] = joinEpisode(t, svc, "episode-big", fmt.Sprintf("p%d", index), false)
		// 120-byte packets put h near the 281 packets/s worst case.
		people[index].publish(t, svc, publishing{cameras: 1, screen: index == 0, chunks: [2]int{120, 300}})
	}
	for _, person := range people {
		var tracks []protocol.Track
		for _, other := range people {
			if other == person {
				continue
			}
			tracks = append(tracks, remote(other, cameraName), remote(other, micName))
			if other == people[0] {
				tracks = append(tracks, remote(other, screenName))
			}
		}
		for batch := range slices.Chunk(tracks, protocol.MaxTracksPerRequest) {
			person.pull(t, svc, batch)
		}
	}
	screen := trackKey(people[0], screenName)
	eventually(t, "everyone receives the screen", 20*time.Second, func() bool {
		for _, person := range people[1:] {
			if person.media.videoCount(screen) == 0 {
				return false
			}
		}
		return true
	})
	time.Sleep(10 * time.Second) // the estimates and the plan settle

	counted := func() (total int64) {
		for _, person := range people {
			total += person.sent.Load() + person.media.packets.Load()
		}
		return total
	}
	windowStart, before := time.Now(), counted()
	var samples []float64
	var episode protocol.EpisodeState
	for range 10 {
		time.Sleep(500 * time.Millisecond)
		episode = people[1].inspect(t, svc).Episode
		samples = append(samples, episode.PacketsPerSecond)
	}
	window := time.Since(windowStart)
	measured := float64(counted()-before) / window.Seconds()
	var mean float64
	for _, sample := range samples {
		mean += sample
	}
	mean /= float64(len(samples))
	t.Logf("ten people: peers sent and received %.0f packets/s; the SFU measured %.0f mean, %.0f peak, ceiling %d; %d cameras capped, %d paused",
		measured, mean, slices.Max(samples), episode.CeilingPackets, episode.CappedCameras, episode.PausedCameras)
	if episode.CeilingPackets != ceiling {
		t.Fatalf("Episode ceiling %d, want %d", episode.CeilingPackets, ceiling)
	}
	if measured > ceiling || mean > ceiling {
		t.Fatalf("the Episode carried %.0f packets/s at the peers and %.0f at the SFU, above its %d ceiling", measured, mean, ceiling)
	}
	// Required audio is never dropped to fit.
	to := time.Now()
	for _, person := range people {
		for _, other := range people {
			if other != person {
				assertAudioFlows(t, person.name+" hearing "+other.name, person.media, trackKey(other, micName), windowStart, to)
			}
		}
	}
	for _, person := range people[1:] {
		if count := person.media.videoCount(screen); count == 0 {
			t.Fatalf("%s lost the screen share", person.name)
		}
	}
}

// forbiddenInLogs are what the service must never log: SDP, certificates and
// keys, addresses, and media payloads.
var forbiddenInLogs = map[string]*regexp.Regexp{
	"SDP":         regexp.MustCompile(`(?m)(v=0|a=fingerprint|a=ice-pwd|a=candidate|m=video|m=audio)`),
	"certificate": regexp.MustCompile(`-----BEGIN`),
	"IPv4":        regexp.MustCompile(`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`),
	"payload":     regexp.MustCompile(`(?i)(payload=|\\x[0-9a-f]{2}){1}`),
}

// TestImpairedCallsLogNothingForbidden runs constrained and lossy media and
// scans everything the service logged, every level included.
func TestImpairedCallsLogNothingForbidden(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	alice := joinEpisode(t, svc, "episode-1", "alice", false)
	alice.publish(t, svc, publishing{cameras: 1})
	bob := joinEpisode(t, svc, "episode-1", "bob", false)
	bob.pull(t, svc, []protocol.Track{remote(alice, cameraName), remote(alice, micName)})
	eventually(t, "bob receives video", 10*time.Second, func() bool { return bob.media.videoCount(trackKey(alice, cameraName)) > 50 })
	alice.link.shape(0, 0, 0, 0, 0.05)
	bob.link.shape(150_000, 8_000, 20*time.Millisecond, 0.05, 0)
	time.Sleep(4 * time.Second)
	svc.mustCall(t, "/v1/sessions/"+bob.conn+"/remove", protocol.RemoveSessionRequest{Scope: bob.scope}, nil)
	svc.stop()

	logs := svc.logs.String()
	if logs == "" {
		t.Fatal("the service logged nothing, so the scan proves nothing")
	}
	for what, pattern := range forbiddenInLogs {
		if match := pattern.FindString(logs); match != "" {
			line := logs[max(strings.Index(logs, match)-200, 0):min(strings.Index(logs, match)+len(match)+50, len(logs))]
			t.Errorf("the service logged %s: %q", what, line)
		}
	}
}

// trace logs a subscriber's transport and one subscription every 100 ms until
// the test ends, when SFU_TRACE is set. It is for tuning the harness.
func trace(t *testing.T, svc *service, subscriber, publisher *participant, name string) {
	if os.Getenv("SFU_TRACE") == "" {
		return
	}
	start := time.Now()
	ctx, stop := context.WithCancel(context.Background())
	var tracing sync.WaitGroup
	t.Cleanup(func() { stop(); tracing.Wait() })
	tracing.Go(func() {
		for ctx.Err() == nil {
			track, response := subscriber.subscription(t, svc, publisher, name)
			transport := response.Transport
			t.Logf("trace %s %6.1fs %-6s %-10s rid %-2q est %7d proven %7d queued %6d sent %+v dropped %d cut %d probes %d/%d",
				subscriber.name, time.Since(start).Seconds(), track.Subscription.State, track.Subscription.Reason, track.Subscription.EffectiveRID,
				transport.EstimateBps, transport.ProvenBps, transport.QueuedBytes, transport.Sent, transport.Dropped, transport.RepairsCut, transport.ProvedProbe, transport.Probes)
			time.Sleep(100 * time.Millisecond)
		}
	})
}
