package tests

import (
	"bytes"
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// peer is a real Pion peer connection that talks to the SFU on loopback.
type peer struct {
	pc *webrtc.PeerConnection
}

func newPeer(t *testing.T, configure ...func(*webrtc.SettingEngine)) *peer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	for _, apply := range configure {
		apply(&settings)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	p := &peer{pc: pc}
	t.Cleanup(func() { _ = pc.Close() })
	return p
}

// complete sets the local description and waits for ICE gathering, so the SDP carries candidates.
func (p *peer) complete(t *testing.T, description webrtc.SessionDescription) protocol.SessionDescription {
	t.Helper()
	gathered := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(description); err != nil {
		t.Fatal(err)
	}
	<-gathered
	local := p.pc.LocalDescription()
	return protocol.SessionDescription{SDP: local.SDP, Type: local.Type.String()}
}

func (p *peer) mid(t *testing.T, track *webrtc.TrackLocalStaticRTP) string {
	t.Helper()
	for _, transceiver := range p.pc.GetTransceivers() {
		if sender := transceiver.Sender(); sender != nil && sender.Track() != nil && sender.Track().ID() == track.ID() {
			return transceiver.Mid()
		}
	}
	t.Fatalf("no transceiver for track %s", track.ID())
	return ""
}

// payloadFor builds the known payload of packet number index: the VP8 start-of-partition
// byte, a kind tag, and the index.
func payloadFor(kind byte, index int) []byte {
	return []byte{0x10, kind, byte(index >> 8), byte(index), 'c', 'h', 'a', 'l', 'k'}
}

// sendLoop writes known RTP until ctx ends. It reports how many packets it sent.
func sendLoop(ctx context.Context, track *webrtc.TrackLocalStaticRTP, kind byte, payloadType uint8, sent *atomic.Int64, done *sync.WaitGroup) {
	done.Go(func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for index := 0; ; index++ {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			packet := &rtp.Packet{
				Header:  rtp.Header{Version: 2, PayloadType: payloadType, SequenceNumber: uint16(firstSequence + index), Timestamp: uint32(index * 960), Marker: true},
				Payload: payloadFor(kind, index),
			}
			if err := track.WriteRTP(packet); err != nil {
				return
			}
			sent.Add(1)
		}
	})
}

// receiver records the RTP packets one peer receives, per kind.
type receiver struct {
	mu        sync.Mutex
	packets   map[webrtc.RTPCodecType][]*rtp.Packet
	readersWG sync.WaitGroup
}

func collect(p *peer) *receiver {
	r := &receiver{packets: map[webrtc.RTPCodecType][]*rtp.Packet{}}
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		r.readersWG.Go(func() {
			for {
				packet, _, err := remote.ReadRTP()
				if err != nil {
					return
				}
				r.mu.Lock()
				r.packets[remote.Kind()] = append(r.packets[remote.Kind()], packet)
				r.mu.Unlock()
			}
		})
	})
	return r
}

func (r *receiver) count(kind webrtc.RTPCodecType) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.packets[kind])
}

func (r *receiver) snapshot(kind webrtc.RTPCodecType) []*rtp.Packet {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*rtp.Packet(nil), r.packets[kind]...)
}

// publication is a peer that pushes known audio and video RTP to a session.
type publication struct {
	peer                 *peer
	audio, video         *webrtc.TrackLocalStaticRTP
	audioMid, videoMid   string
	audioSent, videoSent atomic.Int64
	stopSending          context.CancelFunc
	senders              sync.WaitGroup
}

// stop ends the senders and waits for them.
func (p *publication) stop() { p.stopSending(); p.senders.Wait() }

// publishKnownMedia pushes a microphone and a camera track on connection conn and starts
// sending known RTP on both, as the SDK does.
func publishKnownMedia(t *testing.T, svc *service, conn string, scope protocol.Scope, configure ...func(*webrtc.SettingEngine)) *publication {
	t.Helper()
	alice := newPeer(t, configure...)
	audio, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", scope.ParticipantID)
	if err != nil {
		t.Fatal(err)
	}
	video, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", scope.ParticipantID)
	if err != nil {
		t.Fatal(err)
	}
	for _, track := range []*webrtc.TrackLocalStaticRTP{audio, video} {
		if _, err := alice.pc.AddTrack(track); err != nil {
			t.Fatal(err)
		}
	}
	offer, err := alice.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	pushOffer := alice.complete(t, offer)
	audioMid, videoMid := alice.mid(t, audio), alice.mid(t, video)

	var pushed protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+conn+"/tracks", protocol.TracksRequest{OperationID: op(),
		Scope:              scope,
		SessionDescription: &pushOffer,
		Tracks: []protocol.Track{
			{Location: protocol.LocationLocal, Mid: audioMid, TrackName: audioName, Source: "microphone"},
			{Location: protocol.LocationLocal, Mid: videoMid, TrackName: videoName, Source: "camera"},
		},
	}, &pushed)
	if pushed.SessionDescription == nil || pushed.SessionDescription.Type != "answer" || len(pushed.Tracks) != 2 || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push response: %+v", pushed)
	}
	if err := alice.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}

	sendCtx, stopSending := context.WithCancel(context.Background())
	pub := &publication{peer: alice, audio: audio, video: video, audioMid: audioMid, videoMid: videoMid, stopSending: stopSending}
	sendLoop(sendCtx, audio, 'a', 111, &pub.audioSent, &pub.senders)
	sendLoop(sendCtx, video, 'v', 96, &pub.videoSent, &pub.senders)
	return pub
}

// subscribeKnownMedia pulls the publisher's two tracks on connection conn and answers the SFU's
// offer through Renegotiate. The returned receiver records what arrives.
func subscribeKnownMedia(t *testing.T, svc *service, conn string, scope protocol.Scope, publisherConn string) (*peer, *receiver) {
	t.Helper()
	bob := newPeer(t)
	received := collect(bob)
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+conn+"/tracks", protocol.TracksRequest{OperationID: op(),
		Scope: scope,
		Tracks: []protocol.Track{
			{Location: protocol.LocationRemote, SessionID: publisherConn, TrackName: audioName},
			{Location: protocol.LocationRemote, SessionID: publisherConn, TrackName: videoName, Simulcast: &protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}},
		},
	}, &pulled)
	if pulled.SessionDescription == nil || pulled.SessionDescription.Type != "offer" || !pulled.RequiresImmediateRenegotiation || len(pulled.Tracks) != 2 || len(pulled.TrackErrors) != 0 {
		t.Fatalf("pull response: %+v", pulled)
	}
	mids := map[string]bool{}
	for _, track := range pulled.Tracks {
		if track.Location != protocol.LocationRemote || track.SessionID != publisherConn || track.Mid == "" || mids[track.Mid] {
			t.Fatalf("pulled track identity: %+v", track)
		}
		mids[track.Mid] = true
	}
	if err := bob.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := bob.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	answerSDP := bob.complete(t, answer)
	svc.mustCall(t, "/v1/sessions/"+conn+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: scope, SessionDescription: answerSDP}, nil)
	return bob, received
}

func eventually(t *testing.T, what string, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// assertKnownStream checks every packet carries the sender's payload for kind, that its
// sequence number is the one the sender gave that payload, and that sequences increase.
func assertKnownStream(t *testing.T, label string, packets []*rtp.Packet, kind byte) {
	t.Helper()
	if late := countLate(t, label, packets, kind); late > 0 {
		t.Fatalf("%s: %d packets arrived late or twice", label, late)
	}
}

// countLate checks every packet carries the sender's payload for kind under the sequence number the
// sender gave it, and returns how many arrived after a higher sequence number or a second time. Over
// the internet that happens: UDP reorders, and the subscriber's NACKs make the SFU retransmit.
func countLate(t *testing.T, label string, packets []*rtp.Packet, kind byte) int {
	t.Helper()
	if len(packets) == 0 {
		t.Fatalf("%s: no packets", label)
	}
	seen := map[uint16]bool{}
	var highest uint16
	late := 0
	for position, packet := range packets {
		if len(packet.Payload) != len(payloadFor(kind, 0)) {
			t.Fatalf("%s: packet %d has payload %v", label, position, packet.Payload)
		}
		index := int(packet.Payload[2])<<8 | int(packet.Payload[3])
		if !bytes.Equal(packet.Payload, payloadFor(kind, index)) {
			t.Fatalf("%s: packet %d payload %v is not the sent payload", label, position, packet.Payload)
		}
		if packet.SequenceNumber != uint16(firstSequence+index) {
			t.Fatalf("%s: packet %d has sequence %d for payload index %d", label, position, packet.SequenceNumber, index)
		}
		repeated := seen[packet.SequenceNumber]
		seen[packet.SequenceNumber] = true
		if repeated || (position > 0 && int16(packet.SequenceNumber-highest) < 0) {
			late++
			continue
		}
		highest = packet.SequenceNumber
	}
	return late
}
