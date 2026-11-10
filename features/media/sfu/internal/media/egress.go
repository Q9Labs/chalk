package media

import (
	"encoding/binary"
	"fmt"
	"strings"
	"sync/atomic"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// egressTrack is one subscriber's outgoing track. Unlike a shared static track
// it has a single binding, so each subscriber gets its own sequence space. Its
// ID and stream ID are the publication's track name and the publisher's
// connection ID, the identity the SDK matches.
type egressTrack struct {
	id        string
	streamID  string
	codec     webrtc.RTPCodecCapability
	kind      webrtc.RTPCodecType
	transport *transport
	binding   atomic.Pointer[egressBinding]
	// rtx numbers the RTX stream of the track's section. A section keeps its RTX SSRC from one
	// track to the next, so every binding of the section draws from one counter: a stale writer
	// of an earlier binding (a probe in flight when its subscription closed) then takes a number
	// of its own, never one the next track uses.
	rtx *atomic.Uint32
}

// egressBinding is what the subscriber negotiated for one outgoing track.
type egressBinding struct {
	writer      webrtc.TrackLocalWriter
	ssrc        uint32
	payloadType uint8
	// rtxSSRC and rtxPayloadType carry repairs and probe padding; 0 without RTX.
	rtxSSRC        uint32
	rtxPayloadType uint8
	// rtxShared is the section's RTX counter; a binding built without one counts on its own.
	rtxShared *atomic.Uint32
	rtxSeq    atomic.Uint32
	// twccID is the transport sequence extension; 0 means the subscriber sends
	// no transport-wide feedback, so the node neither paces nor adapts.
	twccID       uint8
	audioLevelID uint8
}

func newEgressTrack(pub *publication, transport *transport) *egressTrack {
	codec := vp8Capability
	if !pub.video() {
		codec = opusCapability
	}
	return &egressTrack{id: pub.name, streamID: pub.session.id, codec: codec, kind: pub.kind, transport: transport, rtx: new(atomic.Uint32)}
}

// Bind takes the negotiated codec with the track's MIME type, and its RTX and
// header extensions.
func (e *egressTrack) Bind(ctx webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	codecs := ctx.CodecParameters()
	for _, codec := range codecs {
		if !strings.EqualFold(codec.MimeType, e.codec.MimeType) {
			continue
		}
		binding := &egressBinding{writer: ctx.WriteStream(), ssrc: uint32(ctx.SSRC()), payloadType: uint8(codec.PayloadType)}
		if rtx, ok := rtxFor(codecs, codec.PayloadType); ok && ctx.SSRCRetransmission() != 0 {
			binding.rtxSSRC, binding.rtxPayloadType = uint32(ctx.SSRCRetransmission()), uint8(rtx)
			binding.rtxShared = e.rtx
		}
		for _, extension := range ctx.HeaderExtensions() {
			switch extension.URI {
			case sdp.TransportCCURI:
				binding.twccID = uint8(extension.ID)
			case sdp.AudioLevelURI:
				binding.audioLevelID = uint8(extension.ID)
			}
		}
		if previous := e.binding.Swap(binding); previous != nil {
			e.transport.unbind(previous)
		}
		e.transport.bind(binding)
		return codec, nil
	}
	return webrtc.RTPCodecParameters{}, webrtc.ErrUnsupportedCodec
}

// rtxFor finds the RTX payload type that repairs payload type primary.
func rtxFor(codecs []webrtc.RTPCodecParameters, primary webrtc.PayloadType) (webrtc.PayloadType, bool) {
	apt := fmt.Sprintf("apt=%d", primary)
	for _, codec := range codecs {
		if strings.EqualFold(codec.MimeType, webrtc.MimeTypeRTX) && strings.Contains(codec.SDPFmtpLine, apt) {
			return codec.PayloadType, true
		}
	}
	return 0, false
}

func (e *egressTrack) Unbind(webrtc.TrackLocalContext) error {
	if previous := e.binding.Swap(nil); previous != nil {
		e.transport.unbind(previous)
	}
	return nil
}

func (e *egressTrack) ID() string                { return e.id }
func (e *egressTrack) RID() string               { return "" }
func (e *egressTrack) StreamID() string          { return e.streamID }
func (e *egressTrack) Kind() webrtc.RTPCodecType { return e.kind }

// egressPacket is one packet for a subscriber, as the pacer holds it.
type egressPacket struct {
	binding *egressBinding
	// authority is the source's forwarding lease, checked when the packet is
	// written; nil for probe padding, which carries no media.
	authority *sourceAuthority
	// sub is the subscription that sent the packet; nil for probe padding. A packet
	// queued or repaired for a subscription that has since closed, or whose publication
	// was parked, must never leave, so the write checks it with the lease.
	sub           *subscription
	arrival       int64 // when the media packet reached the SFU, monotonic
	class         packetClass
	rtx           bool // sent on the RTX stream; the payload starts with the original sequence number
	marker        bool
	hasAudioLevel bool
	audioLevel    byte
	padding       byte
	seq           uint16
	timestamp     uint32
	payload       []byte
	resumes       uint64 // the publication's resume count when the packet was made
}

// rtpOverhead is the RTP header with both extensions, close enough for pacing.
const rtpOverhead = 12 + 12

func (p *egressPacket) size() int { return rtpOverhead + len(p.payload) + int(p.padding) }

// nextRTXSeq allocates the next number of the binding's RTX stream.
func (b *egressBinding) nextRTXSeq() uint16 {
	if b.rtxShared != nil {
		return uint16(b.rtxShared.Add(1))
	}
	return uint16(b.rtxSeq.Add(1))
}

// allowed reports whether the packet's source may still forward it at now, and its
// subscription is still open on a publication that is not parked.
func (p *egressPacket) allowed(now int64) bool {
	if p.sub != nil && (p.sub.closed.Load() || p.sub.pub.held.Load() || p.sub.pub.resumes.Load() != p.resumes) {
		return false
	}
	return p.authority == nil || p.authority.allows(p.arrival, now)
}

// packetWriter is one goroutine's scratch space for writing translated
// packets, so the forwarding path allocates nothing per packet. Pion encrypts
// and sends before WriteRTP returns, so the space is free again afterwards.
type packetWriter struct {
	header     rtp.Header
	extensions [2]rtp.Extension
	twcc       [2]byte
	level      [1]byte
	payload    [maxPayloadBytes + 2]byte // a payload whose VP8 descriptor changes, or an RTX payload
	stored     [maxPayloadBytes]byte     // a payload loaded from history
}

// transmit writes one packet with its transport sequence number and reports
// whether it went out. Pion binds a sender before its SRTP session starts and
// until then drops writes without an error, so a sent packet is one that wrote
// bytes. A failure affects only this subscriber, and Pion reports a closed
// transport on the next read.
func (w *packetWriter) transmit(p *egressPacket, transportSeq uint16) bool {
	binding := p.binding
	ssrc, payloadType := binding.ssrc, binding.payloadType
	if p.rtx {
		ssrc, payloadType = binding.rtxSSRC, binding.rtxPayloadType
	}
	w.header = rtp.Header{
		Version: 2, Padding: p.padding > 0, PaddingSize: p.padding, Marker: p.marker,
		PayloadType: payloadType, SequenceNumber: p.seq, Timestamp: p.timestamp, SSRC: ssrc,
		Extensions: w.extensions[:0],
	}
	profile := uint16(rtp.ExtensionProfileOneByte)
	if binding.twccID > 14 || binding.audioLevelID > 14 {
		profile = rtp.ExtensionProfileTwoByte
	}
	if binding.twccID != 0 {
		binary.BigEndian.PutUint16(w.twcc[:], transportSeq)
		_ = w.header.SetExtensionWithProfile(binding.twccID, w.twcc[:], profile)
	}
	if p.hasAudioLevel && binding.audioLevelID != 0 {
		w.level[0] = p.audioLevel
		_ = w.header.SetExtensionWithProfile(binding.audioLevelID, w.level[:], profile)
	}
	n, err := binding.writer.WriteRTP(&w.header, p.payload)
	return err == nil && n > 0
}
