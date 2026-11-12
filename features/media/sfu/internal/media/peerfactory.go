package media

import (
	"fmt"
	"io"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/sdp/v3"
	"github.com/pion/transport/v5/packetio"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// peerFactory builds each session's peer connection from settings every
// session shares.
type peerFactory struct {
	engine   *webrtc.MediaEngine
	registry *interceptor.Registry
	settings webrtc.SettingEngine
}

// newPeer builds a peer connection whose RTCP stream buffers hand every
// transport-wide feedback report to feedback. Each peer connection gets its own
// API because the buffer factory is the only place Pion passes every stream's
// RTCP through, and it has no other way to tell peer connections apart.
func (f *peerFactory) newPeer(feedback *transport) (*webrtc.PeerConnection, error) {
	settings := f.settings
	settings.BufferFactory = func(packetType packetio.BufferPacketType, ssrc uint32) io.ReadWriteCloser {
		buffer := boundedBuffer(packetType, ssrc)
		if packetType != packetio.RTCPBufferPacket {
			return buffer
		}
		return feedbackBuffer{packetBuffer: buffer, transport: feedback}
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(f.engine), webrtc.WithInterceptorRegistry(f.registry), webrtc.WithSettingEngine(settings))
	return api.NewPeerConnection(webrtc.Configuration{})
}

// newPeerFactory negotiates only the codecs the node forwards: Opus and VP8.
// Feedback is limited to the keyframe requests the node relays to the publisher.
func newPeerFactory(cfg config.Config, mux ice.UDPMux, tcpMux ice.TCPMux) (*peerFactory, error) {
	engine := &webrtc.MediaEngine{}
	if err := registerCodecs(engine); err != nil {
		return nil, err
	}
	if err := registerHeaderExtensions(engine); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.ConfigureRTCPReports(registry); err != nil {
		return nil, fmt.Errorf("configure RTCP reports: %w", err)
	}
	// Publishers estimate their uplink from the node's transport-wide feedback.
	// This also negotiates the transport sequence extension the node writes on
	// egress for its own estimate of each subscriber.
	if err := webrtc.ConfigureTWCCSender(engine, registry); err != nil {
		return nil, fmt.Errorf("configure transport-wide feedback: %w", err)
	}
	settings, err := peerSettings(cfg, mux, tcpMux)
	if err != nil {
		return nil, err
	}
	return &peerFactory{engine: engine, registry: registry, settings: settings}, nil
}

func registerCodecs(engine *webrtc.MediaEngine) error {
	opus := webrtc.RTPCodecParameters{RTPCodecCapability: opusCapability, PayloadType: opusPayloadType}
	vp8 := webrtc.RTPCodecParameters{RTPCodecCapability: vp8Capability, PayloadType: vp8PayloadType}
	if err := engine.RegisterCodec(opus, webrtc.RTPCodecTypeAudio); err != nil {
		return fmt.Errorf("register Opus: %w", err)
	}
	if err := engine.RegisterCodec(vp8, webrtc.RTPCodecTypeVideo); err != nil {
		return fmt.Errorf("register VP8: %w", err)
	}
	// Repairs travel over RTX in both directions, so a resend never looks like
	// fresh media to loss accounting and bandwidth probes can reuse it.
	rtx := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeRTX, ClockRate: 90000, SDPFmtpLine: fmt.Sprintf("apt=%d", vp8PayloadType)},
		PayloadType:        rtxPayloadType,
	}
	if err := engine.RegisterCodec(rtx, webrtc.RTPCodecTypeVideo); err != nil {
		return fmt.Errorf("register RTX: %w", err)
	}
	return nil
}

func registerHeaderExtensions(engine *webrtc.MediaEngine) error {
	// The node reads a microphone's audio level to keep a speaker's camera
	// longest under congestion, and forwards it so subscribers see who speaks.
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.AudioLevelURI}, webrtc.RTPCodecTypeAudio); err != nil {
		return fmt.Errorf("register audio level header extension: %w", err)
	}
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.SDESMidURI}, kind); err != nil {
			return fmt.Errorf("register MID header extension: %w", err)
		}
	}
	// A browser offers camera simulcast by RID. Negotiating the RID extension lets it
	// send; the node forwards only the first RID whose packets arrive until layer routing lands.
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.SDESRTPStreamIDURI}, webrtc.RTPCodecTypeVideo); err != nil {
		return fmt.Errorf("register RID header extension: %w", err)
	}
	// A simulcast publisher signals no SSRCs, so its RTX streams name their layer
	// with the repaired RID. Without it the node drops every uplink repair.
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.SDESRepairRTPStreamIDURI}, webrtc.RTPCodecTypeVideo); err != nil {
		return fmt.Errorf("register repaired RID header extension: %w", err)
	}
	return nil
}

func peerSettings(cfg config.Config, mux ice.UDPMux, tcpMux ice.TCPMux) (webrtc.SettingEngine, error) {
	settings := webrtc.SettingEngine{}
	settings.SetICEUDPMux(mux)
	settings.SetLite(true)
	networkTypes := []webrtc.NetworkType{webrtc.NetworkTypeUDP4}
	if tcpMux != nil {
		settings.SetICETCPMux(tcpMux)
		networkTypes = append(networkTypes, webrtc.NetworkTypeTCP4)
	}
	settings.SetNetworkTypes(networkTypes)
	settings.SetIncludeLoopbackCandidate(cfg.IncludeLoopback)
	settings.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	if len(cfg.AnnounceIPs) > 0 {
		settings.SetNAT1To1IPs(cfg.AnnounceIPs, webrtc.ICECandidateTypeHost)
	}
	if err := settings.SetAnsweringDTLSRole(webrtc.DTLSRoleServer); err != nil {
		return settings, fmt.Errorf("set DTLS answering role: %w", err)
	}
	return settings, nil
}

// boundedBuffer replaces Pion's per-stream buffer, which allows 1 MB of RTP, with a smaller limit.
func boundedBuffer(packetType packetio.BufferPacketType, _ uint32) packetBuffer {
	buffer := packetBuffer{packetio.NewBuffer()}
	switch packetType {
	case packetio.RTPBufferPacket:
		buffer.SetLimitSize(rtpBufferLimit)
	case packetio.RTCPBufferPacket:
		buffer.SetLimitSize(rtcpBufferLimit)
	}
	return buffer
}

// packetBuffer adapts packetio.Buffer to the reader and writer shapes SRTP
// expects, the same adapter Pion uses for its default buffer.
type packetBuffer struct{ *packetio.Buffer }

func (b packetBuffer) Read(p []byte) (int, error) {
	n, _, err := b.Buffer.Read(p, nil)
	return n, err
}

func (b packetBuffer) Write(p []byte) (int, error) { return b.Buffer.Write(p, nil) }

func (b packetBuffer) ReadWithAttributes(p []byte, attributes packetio.Attributes) (int, packetio.Attributes, error) {
	return b.Buffer.Read(p, attributes)
}

func (b packetBuffer) WriteWithAttributes(p []byte, attributes packetio.Attributes) (int, error) {
	return b.Buffer.Write(p, attributes)
}

// feedbackBuffer is an RTCP stream buffer that also reads the transport-wide
// feedback written to it. A receiver addresses each report to the SSRC of the
// latest packet it got, which is the RTX SSRC while only probe padding flows,
// and Pion reads no RTCP for an RTX SSRC. SRTP writes each RTCP packet of a
// compound to the buffer of every stream it names, so the transport ignores the
// copies.
type feedbackBuffer struct {
	packetBuffer
	transport *transport
}

func (b feedbackBuffer) Write(p []byte) (int, error) {
	b.read(p)
	return b.packetBuffer.Write(p)
}

func (b feedbackBuffer) WriteWithAttributes(p []byte, attributes packetio.Attributes) (int, error) {
	b.read(p)
	return b.packetBuffer.WriteWithAttributes(p, attributes)
}

// read hands p to the transport when it is one transport-wide feedback report.
func (b feedbackBuffer) read(p []byte) {
	if len(p) < 4 || rtcp.PacketType(p[1]) != rtcp.TypeTransportSpecificFeedback || p[0]&0x1f != rtcp.FormatTCC {
		return
	}
	var report rtcp.TransportLayerCC
	if report.Unmarshal(p) == nil {
		b.transport.onFeedback(&report)
	}
}
