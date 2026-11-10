package tests

// Spike for the one-call join (design A): one client offer that both publishes the client's own
// tracks and receives tracks the node pushes. These tests use bare Pion peers configured like the
// node's (ICE lite, DTLS server, Opus and VP8 only), because the question is Pion's.

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func spikeAPI(t *testing.T, lite bool) *webrtc.API {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	opus := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}, PayloadType: 111}
	vp8 := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, PayloadType: 96}
	if err := engine.RegisterCodec(opus, webrtc.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	if err := engine.RegisterCodec(vp8, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	if lite {
		settings.SetLite(true)
		if err := settings.SetAnsweringDTLSRole(webrtc.DTLSRoleServer); err != nil {
			t.Fatal(err)
		}
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings))
}

func spikePeer(t *testing.T, lite bool) *webrtc.PeerConnection {
	t.Helper()
	pc, err := spikeAPI(t, lite).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return pc
}

func spikeTrack(t *testing.T, mime string, rate uint32, id string) *webrtc.TrackLocalStaticRTP {
	t.Helper()
	capability := webrtc.RTPCodecCapability{MimeType: mime, ClockRate: rate}
	if mime == webrtc.MimeTypeOpus {
		capability.Channels = 2
	}
	track, err := webrtc.NewTrackLocalStaticRTP(capability, id, "stream-"+id)
	if err != nil {
		t.Fatal(err)
	}
	return track
}

// spikeClient is the browser-like peer: its own mic and camera (sendonly) interleaved with
// recvonly sections for the node's pushes, in the fixed order mic, remote audios, camera, remote videos.
type spikeClient struct {
	pc         *webrtc.PeerConnection
	mic, cam   *webrtc.TrackLocalStaticRTP
	remoteKind []webrtc.RTPCodecType
}

func newSpikeClient(t *testing.T, remoteAudios, remoteVideos int) *spikeClient {
	t.Helper()
	c := &spikeClient{pc: spikePeer(t, false)}
	c.mic = spikeTrack(t, webrtc.MimeTypeOpus, 48000, "own-mic")
	c.cam = spikeTrack(t, webrtc.MimeTypeVP8, 90000, "own-cam")
	send := webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}
	recv := webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}
	if _, err := c.pc.AddTransceiverFromTrack(c.mic, send); err != nil {
		t.Fatal(err)
	}
	for range remoteAudios {
		if _, err := c.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, recv); err != nil {
			t.Fatal(err)
		}
		c.remoteKind = append(c.remoteKind, webrtc.RTPCodecTypeAudio)
	}
	if _, err := c.pc.AddTransceiverFromTrack(c.cam, send); err != nil {
		t.Fatal(err)
	}
	for range remoteVideos {
		if _, err := c.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, recv); err != nil {
			t.Fatal(err)
		}
		c.remoteKind = append(c.remoteKind, webrtc.RTPCodecTypeVideo)
	}
	return c
}

func gatherLocal(t *testing.T, pc *webrtc.PeerConnection, description webrtc.SessionDescription) webrtc.SessionDescription {
	t.Helper()
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(description); err != nil {
		t.Fatal(err)
	}
	<-gathered
	return *pc.LocalDescription()
}

// nodeSide builds the node's peer the way subscribe() does: sendonly transceivers from tracks,
// created before the client's offer is applied.
func nodeSide(t *testing.T, audios, videos int) (*webrtc.PeerConnection, []*webrtc.TrackLocalStaticRTP, []*webrtc.RTPTransceiver) {
	t.Helper()
	pc := spikePeer(t, true)
	var tracks []*webrtc.TrackLocalStaticRTP
	var transceivers []*webrtc.RTPTransceiver
	add := func(mime string, rate uint32, id string) {
		track := spikeTrack(t, mime, rate, id)
		transceiver, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		if err != nil {
			t.Fatal(err)
		}
		tracks = append(tracks, track)
		transceivers = append(transceivers, transceiver)
	}
	for i := range audios {
		add(webrtc.MimeTypeOpus, 48000, fmt.Sprintf("pull-a%d", i))
	}
	for i := range videos {
		add(webrtc.MimeTypeVP8, 90000, fmt.Sprintf("pull-v%d", i))
	}
	return pc, tracks, transceivers
}

// TestSpikePreCreatedSendersBindToMixedOffer proves that one client offer (own mic, 2 remote
// audios, own camera, 1 remote video) binds the node's three pre-created sendonly transceivers
// to the recvonly sections by kind and order, creates recvonly transceivers only for the client's
// own tracks, and then carries media both ways.
func TestSpikePreCreatedSendersBindToMixedOffer(t *testing.T) {
	client := newSpikeClient(t, 2, 1)
	node, nodeTracks, nodeTransceivers := nodeSide(t, 2, 1)

	nodeReceived := map[string]*atomic.Int64{}
	var nodeMu sync.Mutex
	node.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		nodeMu.Lock()
		counter := &atomic.Int64{}
		nodeReceived[remote.Kind().String()] = counter
		nodeMu.Unlock()
		for {
			if _, _, err := remote.ReadRTP(); err != nil {
				return
			}
			counter.Add(1)
		}
	})
	var clientMu sync.Mutex
	clientReceived := map[string]*atomic.Int64{}
	client.pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		counter := &atomic.Int64{}
		clientMu.Lock()
		clientReceived["mid"+receiver.RTPTransceiver().Mid()+"="+remote.ID()] = counter
		clientMu.Unlock()
		for {
			if _, _, err := remote.ReadRTP(); err != nil {
				return
			}
			counter.Add(1)
		}
	})

	offer, err := client.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	offer = gatherLocal(t, client.pc, offer)
	if err := node.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatalf("node applies the mixed offer: %v", err)
	}
	answer, err := node.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	answer = gatherLocal(t, node, answer)

	// Binding: the pre-created transceivers took mids 1, 2 (audio) and 4 (video), none was duplicated.
	wantMids := []string{"1", "2", "4"}
	for i, transceiver := range nodeTransceivers {
		if transceiver.Mid() != wantMids[i] {
			t.Errorf("pre-created transceiver %d bound to mid %q, want %q", i, transceiver.Mid(), wantMids[i])
		}
		if transceiver.Direction() != webrtc.RTPTransceiverDirectionSendonly {
			t.Errorf("pre-created transceiver %d direction %s, want sendonly", i, transceiver.Direction())
		}
	}
	all := node.GetTransceivers()
	if len(all) != 5 {
		t.Fatalf("node has %d transceivers, want 5 (3 bound + 2 new for the client's own tracks)", len(all))
	}
	for _, transceiver := range all {
		if transceiver.Mid() == "0" || transceiver.Mid() == "3" {
			if transceiver.Direction() != webrtc.RTPTransceiverDirectionRecvonly {
				t.Errorf("mid %s is %s, want recvonly (the client's own track)", transceiver.Mid(), transceiver.Direction())
			}
		}
	}

	if err := client.pc.SetRemoteDescription(answer); err != nil {
		t.Fatalf("client applies the answer: %v", err)
	}

	// Media both ways.
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	var writers sync.WaitGroup
	write := func(track *webrtc.TrackLocalStaticRTP, payloadType uint8) {
		writers.Go(func() {
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			for index := 0; ; index++ {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
				packet := rtpPacket(payloadType, uint16(index))
				if err := track.WriteRTP(packet); err != nil {
					return
				}
			}
		})
	}
	write(client.mic, 111)
	write(client.cam, 96)
	write(nodeTracks[0], 111)
	write(nodeTracks[1], 111)
	write(nodeTracks[2], 96)
	defer writers.Wait()
	defer stop()

	start := time.Now()
	eventually(t, "the node to receive the client's mic and camera and the client to receive all 3 pushed tracks", 10*time.Second, func() bool {
		nodeMu.Lock()
		defer nodeMu.Unlock()
		clientMu.Lock()
		defer clientMu.Unlock()
		if len(nodeReceived) != 2 || len(clientReceived) != 3 {
			return false
		}
		for _, counter := range nodeReceived {
			if counter.Load() < 5 {
				return false
			}
		}
		for _, counter := range clientReceived {
			if counter.Load() < 5 {
				return false
			}
		}
		return true
	})
	t.Logf("media flowing both ways %s after the answer", time.Since(start).Round(time.Millisecond))
	var names []string
	clientMu.Lock()
	for name := range clientReceived {
		names = append(names, name)
	}
	clientMu.Unlock()
	sort.Strings(names)
	t.Logf("client received tracks: %v", names)
	// The i-th pushed track of a kind arrives on the i-th recvonly section of that kind.
	want := []string{"mid1=pull-a0", "mid2=pull-a1", "mid4=pull-v0"}
	if fmt.Sprint(names) != fmt.Sprint(want) {
		t.Fatalf("client received %v, want %v", names, want)
	}
}

func rtpPacket(payloadType uint8, sequence uint16) *rtp.Packet {
	return &rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: payloadType, SequenceNumber: sequence, Timestamp: uint32(sequence) * 960, Marker: true},
		Payload: []byte{0x10, 'c', 'h', 'a', 'l', 'k'},
	}
}

// joinOnNode runs the one-call join against the real service: the joiner offers its own mic
// (mid 0), a recvonly audio per publisher, its own camera, then a recvonly video per publisher,
// and posts one request that names its two local tracks and the publishers' tracks.
// It returns the response and the time from the request to the applied answer.
func joinOnNode(t *testing.T, svc *service, conn string, scope protocol.Scope, audioFrom, videoFrom []string) (*peer, *receiver, *webrtc.TrackLocalStaticRTP, *webrtc.TrackLocalStaticRTP, protocol.TracksResponse, time.Duration) {
	t.Helper()
	joiner := newPeer(t)
	received := collect(joiner)
	mic := spikeTrack(t, webrtc.MimeTypeOpus, 48000, "own-mic")
	cam := spikeTrack(t, webrtc.MimeTypeVP8, 90000, "own-cam")
	send := webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}
	recv := webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}
	mustAdd := func(_ *webrtc.RTPTransceiver, err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	mustAdd(joiner.pc.AddTransceiverFromTrack(mic, send))
	for range audioFrom {
		mustAdd(joiner.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, recv))
	}
	mustAdd(joiner.pc.AddTransceiverFromTrack(cam, send))
	for range videoFrom {
		mustAdd(joiner.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, recv))
	}
	offer, err := joiner.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	description := joiner.complete(t, offer)
	tracks := []protocol.Track{
		{Location: protocol.LocationLocal, Mid: joiner.mid(t, mic), TrackName: "joiner-mic", Source: "microphone"},
		{Location: protocol.LocationLocal, Mid: joiner.mid(t, cam), TrackName: "joiner-cam", Source: "camera"},
	}
	for _, publisher := range audioFrom {
		tracks = append(tracks, protocol.Track{Location: protocol.LocationRemote, SessionID: publisher, TrackName: audioName})
	}
	for _, publisher := range videoFrom {
		tracks = append(tracks, protocol.Track{Location: protocol.LocationRemote, SessionID: publisher, TrackName: videoName})
	}
	started := time.Now()
	var response protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+conn+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: scope, SessionDescription: &description, Tracks: tracks}, &response)
	if response.SessionDescription == nil {
		t.Fatalf("join response has no answer: %+v", response)
	}
	if err := joiner.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: response.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	return joiner, received, mic, cam, response, time.Since(started)
}

func TestSpikeOneCallJoinOnNode(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	svc.grantSources(t, scopeA, scopeB, scopeD)
	connA := svc.createSession(t, "create-alice", scopeA)
	connD := svc.createSession(t, "create-dave", scopeD)
	connB := svc.createSession(t, "create-bob", scopeB)
	alice := publishKnownMedia(t, svc, connA, scopeA)
	defer alice.stop()
	dave := publishKnownMedia(t, svc, connD, scopeD)
	defer dave.stop()

	_, received, mic, cam, response, took := joinOnNode(t, svc, connB, scopeB, []string{connA, connD}, []string{connA, connD})
	t.Logf("join request to applied answer: %s", took.Round(time.Millisecond))
	if len(response.TrackErrors) != 0 || len(response.Tracks) != 6 || response.RequiresImmediateRenegotiation {
		t.Fatalf("join response: %+v", response)
	}
	ctx, stop := context.WithCancel(context.Background())
	var senders sync.WaitGroup
	var micSent, camSent atomic.Int64
	sendLoop(ctx, mic, 'a', 111, &micSent, &senders)
	sendLoop(ctx, cam, 'v', 96, &camSent, &senders)
	defer func() { stop(); senders.Wait() }()

	eventually(t, "two audio and two video tracks to arrive", 20*time.Second, func() bool {
		return received.count(webrtc.RTPCodecTypeAudio) >= 60 && received.count(webrtc.RTPCodecTypeVideo) >= 60
	})
	eventually(t, "the node to see the joiner's own mic and camera", 20*time.Second, func() bool {
		active := 0
		for _, track := range svc.inspect(t, connB, scopeB) {
			if track.Location == protocol.LocationLocal && track.Active {
				active++
			}
		}
		return active == 2
	})
	var locals, remotes int
	for _, track := range svc.inspect(t, connB, scopeB) {
		switch track.Location {
		case protocol.LocationLocal:
			locals++
		case protocol.LocationRemote:
			remotes++
		}
	}
	if locals != 2 || remotes != 4 {
		t.Fatalf("inspect shows %d local and %d remote tracks, want 2 and 4", locals, remotes)
	}
}

// TestSpikeJoinServerTime measures the node's work for one join request: SetRemoteDescription,
// CreateAnswer and SetLocalDescription plus gather, from the node's own timing log, and the whole
// HTTP round trip, for 1 and for 16 remote sections. Set SPIKE_ITERATIONS to change the 40 runs.
func TestSpikeJoinServerTime(t *testing.T) {
	iterations := 40
	if v := os.Getenv("SPIKE_ITERATIONS"); v != "" {
		fmt.Sscan(v, &iterations)
	}
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(c *config.Config) {
		c.MaxSubscriptionsPerSession = 64
		c.MaxSessions = 64
		c.MaxEpisodeParticipants = 64
	})
	var publishers []string
	for i := range 8 {
		scope := protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: fmt.Sprintf("pub-%d", i), Generation: 1}
		svc.grantSources(t, scope)
		conn := svc.createSession(t, fmt.Sprintf("create-pub-%d", i), scope)
		pub := publishKnownMedia(t, svc, conn, scope)
		defer pub.stop()
		publishers = append(publishers, conn)
	}
	for _, remotes := range []int{1, 16} {
		var audio, video []string
		switch remotes {
		case 1:
			audio = publishers[:1]
		case 16:
			audio, video = publishers, publishers
			// 8 audio + 8 video from 8 publishers is 16 remote sections.
		}
		var setRemote, answer, gather, total []float64
		for i := range iterations {
			scope := protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: fmt.Sprintf("join-%d-%d", remotes, i), Generation: 1}
			svc.grantSources(t, scope)
			conn := svc.createSession(t, fmt.Sprintf("create-join-%d-%d", remotes, i), scope)
			before := len(timingLines(svc.logs.String()))
			joiner, _, _, _, response, took := joinOnNode(t, svc, conn, scope, audio, video)
			_ = joiner.pc.Close()
			svc.mustCall(t, "/v1/sessions/"+conn+"/remove", protocol.RemoveSessionRequest{Scope: scope}, nil)
			if len(response.TrackErrors) != 0 {
				t.Fatalf("join errors: %+v", response.TrackErrors)
			}
			lines := timingLines(svc.logs.String())
			if len(lines) != before+1 {
				t.Fatalf("expected one new timing line, got %d", len(lines)-before)
			}
			a, b, c := parseTiming(t, lines[len(lines)-1])
			setRemote, answer, gather, total = append(setRemote, a), append(answer, b), append(gather, c), append(total, float64(took.Microseconds()))
		}
		t.Logf("remote=%2d n=%d  SetRemoteDescription p50=%.2fms p95=%.2fms | CreateAnswer p50=%.2fms p95=%.2fms | SetLocal+gather p50=%.2fms p95=%.2fms | node sum p95=%.2fms | HTTP round trip p50=%.2fms p95=%.2fms",
			remotes, iterations, pct(setRemote, 50), pct(setRemote, 95), pct(answer, 50), pct(answer, 95), pct(gather, 50), pct(gather, 95), pct(sum3(setRemote, answer, gather), 95), pct(total, 50), pct(total, 95))
	}
}

var timingPattern = regexp.MustCompile(`spike join timing.*?setRemote=(\d+) createAnswer=(\d+) setLocalAndGather=(\d+)`)

func timingLines(logs string) []string { return timingPattern.FindAllString(logs, -1) }

func parseTiming(t *testing.T, line string) (float64, float64, float64) {
	t.Helper()
	m := timingPattern.FindStringSubmatch(line)
	if m == nil {
		t.Fatalf("no timing in %q", line)
	}
	var out [3]float64
	for i := range out {
		v, _ := strconv.ParseFloat(m[i+1], 64)
		out[i] = v
	}
	return out[0], out[1], out[2]
}

func sum3(a, b, c []float64) []float64 {
	out := make([]float64, len(a))
	for i := range a {
		out[i] = a[i] + b[i] + c[i]
	}
	return out
}

// pct returns the p-th percentile of microsecond samples, in milliseconds.
func pct(samples []float64, p int) float64 {
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	index := (len(sorted)*p + 99) / 100
	if index < 1 {
		index = 1
	}
	return sorted[index-1] / 1000
}
