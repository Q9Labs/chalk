package pion

import (
	"strings"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// MediaTrack retains the authenticated Chalk track and exposes only bounded
// RTP reads from Pion's remote track. It does not buffer packets in memory.
type MediaTrack struct {
	identity captureplane.PulledCaptureTrack
	mid      captureplane.ProviderReference
	rid      string
	remote   *webrtc.TrackRemote
	receiver *webrtc.RTPReceiver
	boundAt  time.Time
}

// BoundAt is when OnTrack bound this track, which Pion does as the first RTP
// packet arrives. A reader that starts later can anchor the track's clock here
// instead of at its own first read.
func (t *MediaTrack) BoundAt() time.Time {
	if t == nil {
		return time.Time{}
	}
	return t.boundAt
}

// CaptureTrack returns the identity registered before SDP was applied.
func (t *MediaTrack) CaptureTrack() captureplane.PulledCaptureTrack {
	if t == nil {
		return captureplane.PulledCaptureTrack{}
	}
	return t.identity
}

// MID is the negotiated transceiver MID used for this binding.
func (t *MediaTrack) MID() captureplane.ProviderReference {
	if t == nil {
		return ""
	}
	return t.mid
}

// RID is the RTP stream RID observed by Pion. It is empty for a non-simulcast
// stream and for the primary stream selected by Pion's receiver.
func (t *MediaTrack) RID() string {
	if t == nil {
		return ""
	}
	return t.rid
}

// Codec returns the normalized codec name negotiated for this remote RTP
// stream. It is available only after Pion binds the remote track.
func (t *MediaTrack) Codec() string {
	if t == nil || t.remote == nil {
		return ""
	}
	mimeType := strings.ToLower(strings.TrimSpace(t.remote.Codec().MimeType))
	if _, codec, found := strings.Cut(mimeType, "/"); found {
		return codec
	}
	return mimeType
}

// ReadRTP reads one packet from the bounded Pion receiver.
func (t *MediaTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	if t == nil || t.remote == nil {
		return nil, nil, ErrPeerClosed
	}
	return t.remote.ReadRTP()
}

// ReadRTCP reads the sender's clock reports without consuming RTP media.
func (t *MediaTrack) ReadRTCP() ([]rtcp.Packet, interceptor.Attributes, error) {
	if t == nil || t.receiver == nil {
		return nil, nil, ErrPeerClosed
	}
	return t.receiver.ReadRTCP()
}

// SetRTCPReadDeadline bounds reads independently of the media deadline.
func (t *MediaTrack) SetRTCPReadDeadline(deadline time.Time) error {
	if t == nil || t.receiver == nil {
		return ErrPeerClosed
	}
	return t.receiver.SetReadDeadline(deadline)
}

// Read reads one RTP packet into the caller-provided bounded buffer.
func (t *MediaTrack) Read(buffer []byte) (int, interceptor.Attributes, error) {
	if t == nil || t.remote == nil {
		return 0, nil, ErrPeerClosed
	}
	return t.remote.Read(buffer)
}

// SetReadDeadline bounds a worker's wait for the next RTP packet.
func (t *MediaTrack) SetReadDeadline(deadline time.Time) error {
	if t == nil || t.remote == nil {
		return ErrPeerClosed
	}
	return t.remote.SetReadDeadline(deadline)
}
