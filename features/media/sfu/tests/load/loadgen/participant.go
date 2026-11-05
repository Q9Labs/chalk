package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

var (
	opusCapability = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: audioClock, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}
	vp8Capability  = webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: videoClock,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}},
	}
)

// newAPI builds the Pion API every generated peer shares. It negotiates what the SFU
// does (Opus, VP8, MID and RID extensions) and runs the RTCP sender and receiver reports
// a normal client sends.
func newAPI(iface string, loopback bool) (*webrtc.API, error) {
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: opusCapability, PayloadType: opusPT}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: vp8Capability, PayloadType: vp8PT}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.SDESMidURI}, kind); err != nil {
			return nil, err
		}
	}
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.SDESRTPStreamIDURI}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.ConfigureRTCPReports(registry); err != nil {
		return nil, err
	}
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(loopback)
	if iface != "" {
		settings.SetInterfaceFilter(func(name string) bool { return name == iface })
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)), nil
}

// participant is one real Pion peer connection and its SFU session. Like the SDK, it
// pushes its own camera and microphone and pulls everyone else's on the same connection.
type participant struct {
	scope     protocol.Scope
	pc        *webrtc.PeerConnection
	sessionID string

	audioName, videoName string
	sources              []*source
	received             streamSet

	connected chan struct{}
	dropped   atomic.Bool
	stopSend  context.CancelFunc
	senders   sync.WaitGroup
}

// workload is what every participant publishes.
type workload struct {
	videoBitrate, lowBitrate float64
	videoBytes, audioBytes   int
	audioPPS                 float64
	publishLow               bool
	lowLag                   time.Duration
}

func ppsFor(bitrate float64, payloadBytes int) float64 {
	return bitrate / 8 / float64(payloadBytes+12)
}

func (p *participant) closePeer() {
	if p.stopSend != nil {
		p.stopSend()
	}
	p.senders.Wait()
	_ = p.pc.Close()
}

// join creates the session and pushes the camera and microphone.
func (g *generator) join(ctx context.Context, scope protocol.Scope) (*participant, error) {
	pc, err := g.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("new peer connection: %w", err)
	}
	p := &participant{
		scope: scope, pc: pc, connected: make(chan struct{}),
		audioName: scope.ParticipantID + "-mic", videoName: scope.ParticipantID + "-cam",
	}
	fail := func(err error) (*participant, error) {
		_ = pc.Close()
		return nil, err
	}

	work := g.cfg.work
	audio, err := webrtc.NewTrackLocalStaticRTP(opusCapability, "mic", scope.ParticipantID)
	if err != nil {
		return fail(err)
	}
	videoHigh, err := webrtc.NewTrackLocalStaticRTP(vp8Capability, "cam", scope.ParticipantID, webrtc.WithRTPStreamID("h"))
	if err != nil {
		return fail(err)
	}
	sendOnly := webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}
	if _, err := pc.AddTransceiverFromTrack(audio, sendOnly); err != nil {
		return fail(err)
	}
	videoTransceiver, err := pc.AddTransceiverFromTrack(videoHigh, sendOnly)
	if err != nil {
		return fail(err)
	}
	videoSender := videoTransceiver.Sender()
	p.sources = []*source{
		newSource(audio, opusPT, audioClock, work.audioPPS, work.audioBytes, false, 0),
		newSource(videoHigh, vp8PT, videoClock, ppsFor(work.videoBitrate, work.videoBytes), work.videoBytes, true, 0).withRID("h"),
	}
	if work.publishLow {
		videoLow, err := webrtc.NewTrackLocalStaticRTP(vp8Capability, "cam", scope.ParticipantID, webrtc.WithRTPStreamID("l"))
		if err != nil {
			return fail(err)
		}
		if err := videoSender.AddEncoding(videoLow); err != nil {
			return fail(err)
		}
		// The low layer starts later, so the SFU (which forwards the first layer to
		// arrive) forwards the high layer.
		p.sources = append(p.sources, newSource(videoLow, vp8PT, videoClock, ppsFor(work.lowBitrate, work.videoBytes), work.videoBytes, true, work.lowLag).withRID("l"))
	}

	pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		readTrack(remote, receiver, &p.received)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			select {
			case <-p.connected:
			default:
				close(p.connected)
			}
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateDisconnected, webrtc.PeerConnectionStateClosed:
			p.dropped.Store(true)
		}
	})
	// Pion needs the sender's RTCP read to run its interceptors.
	for _, transceiver := range pc.GetTransceivers() {
		if sender := transceiver.Sender(); sender != nil {
			go func() {
				for {
					if _, _, err := sender.ReadRTCP(); err != nil {
						return
					}
				}
			}()
		}
	}

	var created protocol.CreateSessionResponse
	if err := g.control.post(ctx, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "create-" + scope.EpisodeID + "-" + scope.ParticipantID, Scope: scope}, &created); err != nil {
		return fail(err)
	}
	p.sessionID = created.ConnectionID

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fail(err)
	}
	pushOffer, err := complete(pc, offer)
	if err != nil {
		return fail(err)
	}
	audioMid, videoMid := midOf(pc, audio.ID(), webrtc.RTPCodecTypeAudio), midOf(pc, videoHigh.ID(), webrtc.RTPCodecTypeVideo)
	var pushed protocol.TracksResponse
	err = g.control.post(ctx, "/v1/sessions/"+p.sessionID+"/tracks", protocol.TracksRequest{
		Scope:              scope,
		SessionDescription: &pushOffer,
		Tracks: []protocol.Track{
			{Location: protocol.LocationLocal, Mid: audioMid, TrackName: p.audioName, Source: "microphone"},
			{Location: protocol.LocationLocal, Mid: videoMid, TrackName: p.videoName, Source: "camera"},
		},
	}, &pushed)
	if err != nil {
		return fail(err)
	}
	if pushed.SessionDescription == nil || len(pushed.TrackErrors) != 0 {
		return fail(fmt.Errorf("push %s: answer %v, track errors %v", scope.ParticipantID, pushed.SessionDescription != nil, pushed.TrackErrors))
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		return fail(err)
	}
	// A simulcast sender names its layer in the MID and RID header extensions of its packets.
	var midID, ridID uint8
	for _, extension := range videoSender.GetParameters().HeaderExtensions {
		switch extension.URI {
		case sdp.SDESMidURI:
			midID = uint8(extension.ID)
		case sdp.SDESRTPStreamIDURI:
			ridID = uint8(extension.ID)
		}
	}
	for _, s := range p.sources {
		s.setExtensions(videoMid, midID, ridID)
	}
	return p, nil
}

// startSending begins the synthetic RTP once the connection is up.
func (p *participant) startSending(ctx context.Context) {
	ctx, p.stopSend = context.WithCancel(ctx)
	for _, s := range p.sources {
		s.run(ctx, &p.senders)
	}
}

// pull subscribes to every publication in others and answers the SFU's offer.
func (g *generator) pull(ctx context.Context, p *participant, others []*participant) error {
	var tracks []protocol.Track
	for _, other := range others {
		tracks = append(tracks,
			protocol.Track{Location: protocol.LocationRemote, SessionID: other.sessionID, TrackName: other.audioName},
			protocol.Track{Location: protocol.LocationRemote, SessionID: other.sessionID, TrackName: other.videoName,
				Simulcast: &protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}},
		)
	}
	for len(tracks) > 0 {
		batch := tracks[:min(len(tracks), protocol.MaxTracksPerRequest)]
		tracks = tracks[len(batch):]
		var pulled protocol.TracksResponse
		if err := g.control.post(ctx, "/v1/sessions/"+p.sessionID+"/tracks", protocol.TracksRequest{Scope: p.scope, Tracks: batch}, &pulled); err != nil {
			return err
		}
		if len(pulled.TrackErrors) != 0 || pulled.SessionDescription == nil {
			return fmt.Errorf("pull for %s: offer %v, track errors %v", p.scope.ParticipantID, pulled.SessionDescription != nil, pulled.TrackErrors)
		}
		if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
			return err
		}
		answer, err := p.pc.CreateAnswer(nil)
		if err != nil {
			return err
		}
		answerSDP, err := complete(p.pc, answer)
		if err != nil {
			return err
		}
		if err := g.control.post(ctx, "/v1/sessions/"+p.sessionID+"/renegotiate", protocol.RenegotiateRequest{Scope: p.scope, SessionDescription: answerSDP}, nil); err != nil {
			return err
		}
	}
	return nil
}

// complete sets the local description and waits for ICE gathering, so the SDP carries candidates.
func complete(pc *webrtc.PeerConnection, description webrtc.SessionDescription) (protocol.SessionDescription, error) {
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(description); err != nil {
		return protocol.SessionDescription{}, err
	}
	<-gathered
	local := pc.LocalDescription()
	return protocol.SessionDescription{SDP: local.SDP, Type: local.Type.String()}, nil
}

func midOf(pc *webrtc.PeerConnection, trackID string, kind webrtc.RTPCodecType) string {
	for _, transceiver := range pc.GetTransceivers() {
		if sender := transceiver.Sender(); sender != nil && sender.Track() != nil && sender.Track().ID() == trackID && transceiver.Kind() == kind {
			return transceiver.Mid()
		}
	}
	return ""
}
