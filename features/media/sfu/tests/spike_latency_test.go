package tests

// Spike: time to first audio of the join designs over an emulated link. The media path gets half
// the RTT each way (the user-space link in netem_test.go delays inbound packets; delayedLink
// delays outbound ones) and every signalling call pays the signalling RTT around the real HTTP call.

import (
	"context"
	"fmt"
	"net"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// delayedLink adds a fixed one-way delay to what the peer sends; link already delays what it receives.
type delayedLink struct {
	*link
	delay time.Duration
	queue chan delayedWrite
	done  chan struct{}
}

type delayedWrite struct {
	payload []byte
	addr    net.Addr
	at      time.Time
}

func newDelayedLink(t *testing.T, rtt time.Duration) *delayedLink {
	t.Helper()
	l := newLink(t)
	l.shape(0, 0, rtt/2, 0, 0)
	d := &delayedLink{link: l, delay: rtt / 2, queue: make(chan delayedWrite, 8192), done: make(chan struct{})}
	go func() {
		for w := range d.queue {
			if wait := time.Until(w.at); wait > 0 {
				time.Sleep(wait)
			}
			_, _ = d.link.WriteTo(w.payload, w.addr)
		}
		close(d.done)
	}()
	return d
}

func (d *delayedLink) WriteTo(p []byte, addr net.Addr) (int, error) {
	if d.delay == 0 {
		return d.link.WriteTo(p, addr)
	}
	d.queue <- delayedWrite{append([]byte(nil), p...), addr, time.Now().Add(d.delay)}
	return len(p), nil
}

func (d *delayedLink) Close() error {
	close(d.queue)
	<-d.done
	return d.link.Close()
}

// signal runs one signalling call that costs rtt on top of the real round trip.
func signal(rtt time.Duration, call func()) {
	time.Sleep(rtt / 2)
	call()
	time.Sleep(rtt / 2)
}

type joinTimes struct {
	answer, connected, remoteAudio, ownCamera, ownMic time.Duration
}

// joinOnce joins one new session with design "A" (one call), "B" (push with pullPublished, answer
// plus follow-up offer, one renegotiate) or "today" (push, pull, renegotiate), either on a cold
// connection or warm (the mic already publishes and the transport is connected).
func joinOnce(t *testing.T, svc *service, design string, warm bool, mediaRTT, signalRTT time.Duration, publishers []string, n int) joinTimes {
	t.Helper()
	scope := protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: fmt.Sprintf("j-%s-%v-%d", design, warm, n), Generation: 1}
	svc.grantSources(t, scope)
	conn := svc.createSession(t, "create-"+scope.ParticipantID, scope)
	defer svc.call(t, "/v1/sessions/"+conn+"/remove", protocol.RemoveSessionRequest{Scope: scope}, nil)

	through := newDelayedLink(t, mediaRTT)
	client := newPeerOn(t, through)
	mic := spikeTrack(t, webrtc.MimeTypeOpus, 48000, "own-mic")
	cam := spikeTrack(t, webrtc.MimeTypeVP8, 90000, "own-cam")
	send := webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}
	recv := webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}
	add := func(_ *webrtc.RTPTransceiver, err error) {
		if err != nil {
			t.Fatal(err)
		}
	}

	var connectedAt, remoteAudioAt atomic.Int64
	client.pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			connectedAt.CompareAndSwap(0, time.Now().UnixNano())
		}
	})
	client.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if remote.Kind() != webrtc.RTPCodecTypeAudio {
			return
		}
		if _, _, err := remote.ReadRTP(); err == nil {
			remoteAudioAt.CompareAndSwap(0, time.Now().UnixNano())
		}
	})

	ctx, stop := context.WithCancel(context.Background())
	var senders sync.WaitGroup
	var sent atomic.Int64
	defer func() { stop(); senders.Wait() }()

	post := func(request protocol.TracksRequest) protocol.TracksResponse {
		var response protocol.TracksResponse
		signal(signalRTT, func() { svc.mustCall(t, "/v1/sessions/"+conn+"/tracks", request, &response) })
		return response
	}
	applyAnswer := func(d *protocol.SessionDescription) {
		if err := client.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: d.SDP}); err != nil {
			t.Fatal(err)
		}
	}
	// answerOffer applies the server's offer and returns the renegotiate call.
	answerOffer := func(d *protocol.SessionDescription) {
		if err := client.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: d.SDP}); err != nil {
			t.Fatal(err)
		}
		answer, err := client.pc.CreateAnswer(nil)
		if err != nil {
			t.Fatal(err)
		}
		local := client.complete(t, answer)
		signal(signalRTT, func() {
			svc.mustCall(t, "/v1/sessions/"+conn+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: scope, SessionDescription: local}, nil)
		})
	}

	// Warm: the mic is already published and the transport connected before the join starts.
	add(client.pc.AddTransceiverFromTrack(mic, send))
	micPublished := false
	if warm {
		offer, err := client.pc.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		description := client.complete(t, offer)
		var response protocol.TracksResponse
		svc.mustCall(t, "/v1/sessions/"+conn+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: scope, SessionDescription: &description,
			Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: client.mid(t, mic), TrackName: "joiner-mic", Source: "microphone"}}}, &response)
		applyAnswer(response.SessionDescription)
		sendLoop(ctx, mic, 'a', 111, &sent, &senders)
		eventually(t, "the warm connection", 15*time.Second, func() bool { return connectedAt.Load() != 0 })
		micPublished = true
		connectedAt.Store(0)
	}

	// Build the join offer.
	pullsInOffer := design == "A"
	if pullsInOffer {
		for range publishers {
			add(client.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, recv))
		}
	}
	add(client.pc.AddTransceiverFromTrack(cam, send))
	if pullsInOffer {
		for range publishers {
			add(client.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, recv))
		}
	}
	offer, err := client.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	description := client.complete(t, offer)
	var locals, remotes []protocol.Track
	if !micPublished {
		locals = append(locals, protocol.Track{Location: protocol.LocationLocal, Mid: client.mid(t, mic), TrackName: "joiner-mic", Source: "microphone"})
	}
	locals = append(locals, protocol.Track{Location: protocol.LocationLocal, Mid: client.mid(t, cam), TrackName: "joiner-cam", Source: "camera"})
	for _, name := range []string{audioName, videoName} {
		for _, publisher := range publishers {
			remotes = append(remotes, protocol.Track{Location: protocol.LocationRemote, SessionID: publisher, TrackName: name})
		}
	}

	t0 := time.Now()
	var answered time.Time
	switch design {
	case "A":
		response := post(protocol.TracksRequest{OperationID: op(), Scope: scope, SessionDescription: &description, Tracks: append(locals, remotes...)})
		applyAnswer(response.SessionDescription)
		answered = time.Now()
	case "B":
		response := post(protocol.TracksRequest{OperationID: op(), Scope: scope, SessionDescription: &description, Tracks: append(locals, remotes...), PullPublished: true})
		applyAnswer(response.SessionDescription)
		answered = time.Now()
		sendLoop(ctx, mic, 'a', 111, &sent, &senders)
		answerOffer(response.FollowUpOffer)
	case "today":
		response := post(protocol.TracksRequest{OperationID: op(), Scope: scope, SessionDescription: &description, Tracks: locals})
		applyAnswer(response.SessionDescription)
		answered = time.Now()
		pulled := post(protocol.TracksRequest{OperationID: op(), Scope: scope, Tracks: remotes})
		answerOffer(pulled.SessionDescription)
	}
	if !micPublished && design != "B" {
		sendLoop(ctx, mic, 'a', 111, &sent, &senders)
	}
	sendLoop(ctx, cam, 'v', 96, &sent, &senders)

	// Observe the node's view of the joiner's own tracks without the emulated signalling cost.
	var ownMicAt, ownCamAt time.Time
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if ownCamAt.IsZero() || (ownMicAt.IsZero() && !micPublished) {
			for _, track := range svc.inspect(t, conn, scope) {
				if track.Active && track.TrackName == "joiner-mic" && ownMicAt.IsZero() {
					ownMicAt = time.Now()
				}
				if track.Active && track.TrackName == "joiner-cam" && ownCamAt.IsZero() {
					ownCamAt = time.Now()
				}
			}
		}
		if remoteAudioAt.Load() != 0 && !ownCamAt.IsZero() && (micPublished || !ownMicAt.IsZero()) && connectedAt.Load() != 0 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if remoteAudioAt.Load() == 0 || ownCamAt.IsZero() {
		t.Fatalf("%s warm=%v never delivered: remote audio %v, own camera %v", design, warm, remoteAudioAt.Load() != 0, !ownCamAt.IsZero())
	}
	result := joinTimes{answer: answered.Sub(t0), remoteAudio: time.Unix(0, remoteAudioAt.Load()).Sub(t0), ownCamera: ownCamAt.Sub(t0)}
	if connectedAt.Load() != 0 {
		result.connected = time.Unix(0, connectedAt.Load()).Sub(t0)
	}
	if !ownMicAt.IsZero() {
		result.ownMic = ownMicAt.Sub(t0)
	}
	return result
}

func median(values []time.Duration) time.Duration {
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return sorted[len(sorted)/2]
}

// TestSpikeJoinLatency compares the designs. SPIKE_ITERATIONS sets the runs per cell (default 5).
func TestSpikeJoinLatency(t *testing.T) {
	runs := 5
	if v := envInt("SPIKE_ITERATIONS"); v > 0 {
		runs = v
	}
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(c *config.Config) {
		c.MaxSessions = 128
		c.MaxEpisodeParticipants = 128
		c.MaxSubscriptionsPerSession = 32
	})
	var publishers []string
	for i := range 2 {
		scope := protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: fmt.Sprintf("pub-%d", i), Generation: 1}
		svc.grantSources(t, scope)
		conn := svc.createSession(t, fmt.Sprintf("create-pub-%d", i), scope)
		pub := publishKnownMedia(t, svc, conn, scope)
		defer pub.stop()
		publishers = append(publishers, conn)
	}
	counter := 0
	for _, link := range []struct{ media, signal time.Duration }{{0, 0}, {100 * time.Millisecond, 100 * time.Millisecond}, {100 * time.Millisecond, 30 * time.Millisecond}, {30 * time.Millisecond, 100 * time.Millisecond}} {
		for _, warm := range []bool{false, true} {
			for _, design := range []string{"today", "B", "A"} {
				var answer, connected, remote, camera, mic []time.Duration
				for range runs {
					counter++
					r := joinOnce(t, svc, design, warm, link.media, link.signal, publishers, counter)
					answer, connected, remote, camera = append(answer, r.answer), append(connected, r.connected), append(remote, r.remoteAudio), append(camera, r.ownCamera)
					mic = append(mic, r.ownMic)
				}
				t.Logf("mediaRTT=%3dms signalRTT=%3dms warm=%-5v %-5s  answer=%4dms connected=%4dms firstRemoteAudio=%4dms ownCameraAtNode=%4dms ownMicAtNode=%4dms",
					link.media.Milliseconds(), link.signal.Milliseconds(), warm, design, median(answer).Milliseconds(), median(connected).Milliseconds(), median(remote).Milliseconds(), median(camera).Milliseconds(), median(mic).Milliseconds())
			}
		}
	}
}

func envInt(name string) int {
	var n int
	_, _ = fmt.Sscan(os.Getenv(name), &n)
	return n
}

// newPeerOn is newMediaPeer for any packet connection.
func newPeerOn(t *testing.T, conn net.PacketConn) *peer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: conn})
	settings.SetICEUDPMux(mux)
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = pc.Close()
		_ = mux.Close()
	})
	return &peer{pc: pc}
}

// TestSpikeColdConnectCell runs design A on a cold connection at SPIKE_RTT_MS (default 100) for
// SPIKE_ITERATIONS runs (default 9) and logs the median connect and first-audio times.
func TestSpikeColdConnectCell(t *testing.T) {
	rtt := 100 * time.Millisecond
	if v := envInt("SPIKE_RTT_MS"); v > 0 {
		rtt = time.Duration(v) * time.Millisecond
	}
	runs := 9
	if v := envInt("SPIKE_ITERATIONS"); v > 0 {
		runs = v
	}
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(c *config.Config) { c.MaxSessions = 128; c.MaxEpisodeParticipants = 128 })
	var publishers []string
	for i := range 2 {
		scope := protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: fmt.Sprintf("pub-%d", i), Generation: 1}
		svc.grantSources(t, scope)
		conn := svc.createSession(t, fmt.Sprintf("create-pub-%d", i), scope)
		pub := publishKnownMedia(t, svc, conn, scope)
		defer pub.stop()
		publishers = append(publishers, conn)
	}
	var connected, remote, mic []time.Duration
	for i := range runs {
		r := joinOnce(t, svc, "A", false, rtt, rtt, publishers, i)
		connected, remote, mic = append(connected, r.connected), append(remote, r.remoteAudio), append(mic, r.ownMic)
	}
	t.Logf("rtt=%dms skipHelloVerify=%v n=%d  connected p50=%dms firstRemoteAudio p50=%dms ownMicAtNode p50=%dms (min connected %dms)",
		rtt.Milliseconds(), os.Getenv("SPIKE_SKIP_HVR") != "", runs, median(connected).Milliseconds(), median(remote).Milliseconds(), median(mic).Milliseconds(), minDuration(connected).Milliseconds())
}

func minDuration(values []time.Duration) time.Duration {
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return sorted[0]
}
