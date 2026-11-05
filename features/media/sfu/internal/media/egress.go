package media

import (
	"strings"
	"sync/atomic"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// egressTrack is one subscriber's outgoing track. Unlike a shared static track
// it has a single binding, so each subscriber gets its own sequence space. Its
// ID and stream ID are the publication's track name and the publisher's
// connection ID, the identity the SDK matches.
type egressTrack struct {
	id       string
	streamID string
	codec    webrtc.RTPCodecCapability
	kind     webrtc.RTPCodecType
	binding  atomic.Pointer[egressBinding]
}

type egressBinding struct {
	writer      webrtc.TrackLocalWriter
	ssrc        uint32
	payloadType uint8
}

func newEgressTrack(pub *publication) *egressTrack {
	codec := vp8Capability
	if !pub.video() {
		codec = opusCapability
	}
	return &egressTrack{id: pub.name, streamID: pub.session.id, codec: codec, kind: pub.kind}
}

// Bind takes the negotiated codec with the track's MIME type.
func (e *egressTrack) Bind(ctx webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	for _, codec := range ctx.CodecParameters() {
		if strings.EqualFold(codec.MimeType, e.codec.MimeType) {
			e.binding.Store(&egressBinding{writer: ctx.WriteStream(), ssrc: uint32(ctx.SSRC()), payloadType: uint8(codec.PayloadType)})
			return codec, nil
		}
	}
	return webrtc.RTPCodecParameters{}, webrtc.ErrUnsupportedCodec
}

func (e *egressTrack) Unbind(webrtc.TrackLocalContext) error {
	e.binding.Store(nil)
	return nil
}

func (e *egressTrack) ID() string                { return e.id }
func (e *egressTrack) RID() string               { return "" }
func (e *egressTrack) StreamID() string          { return e.streamID }
func (e *egressTrack) Kind() webrtc.RTPCodecType { return e.kind }

// packetWriter is one goroutine's scratch space for writing translated
// packets, so the forwarding path allocates nothing per packet. Pion encrypts
// and sends before WriteRTP returns, so the space is free again afterwards.
type packetWriter struct {
	header  rtp.Header
	payload [maxPayloadBytes]byte // a payload whose VP8 descriptor changes
	stored  [maxPayloadBytes]byte // a payload loaded from history
}

// write sends p as out on the track and reports whether it went out. Pion
// binds a sender before its SRTP session starts and until then drops writes
// without an error, so a sent packet is one that wrote bytes. A failure affects
// only this subscriber, and Pion reports a closed transport on the next read.
func (w *packetWriter) write(track *egressTrack, p *rtpPacket, out outgoing) bool {
	binding := track.binding.Load()
	if binding == nil {
		return false
	}
	payload := p.payload
	if p.hasVP8 && out.vp8.differs(&p.vp8) {
		n := copy(w.payload[:], p.payload)
		out.vp8.apply(&p.vp8, w.payload[:n])
		payload = w.payload[:n]
	}
	w.header = rtp.Header{
		Version: 2, Padding: p.paddingSize > 0, PaddingSize: p.paddingSize, Marker: p.marker,
		PayloadType: binding.payloadType, SequenceNumber: out.seq, Timestamp: out.timestamp, SSRC: binding.ssrc,
	}
	n, err := binding.writer.WriteRTP(&w.header, payload)
	return err == nil && n > 0
}
