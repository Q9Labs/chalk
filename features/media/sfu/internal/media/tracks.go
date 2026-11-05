package media

import (
	"errors"
	"fmt"
	"io"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const sourceScreen = "screen"

const (
	// activeWindow is how recently RTP must have arrived for a track to count as active.
	activeWindow = 5 * time.Second
	// keyframeInterval coalesces keyframe requests that subscribers send to one publisher.
	keyframeInterval = time.Second
)

// publication is a track a session publishes. Its local track fans the
// publisher's RTP out to every subscriber's sender.
type publication struct {
	session *Session
	name    string
	source  string
	local   *webrtc.TrackLocalStaticRTP

	closed    atomic.Bool
	remote    atomic.Pointer[webrtc.TrackRemote]
	lastRTP   atomic.Int64
	lastAsked atomic.Int64
}

func newPublication(session *Session, track protocol.Track, kind webrtc.RTPCodecType) (*publication, error) {
	capability := vp8Capability
	if kind == webrtc.RTPCodecTypeAudio {
		capability = opusCapability
	}
	local, err := webrtc.NewTrackLocalStaticRTP(capability, track.TrackName, session.id)
	if err != nil {
		return nil, fmt.Errorf("create forwarding track: %w", err)
	}
	return &publication{session: session, name: track.TrackName, source: track.Source, local: local}, nil
}

// attach binds the publisher's incoming RTP. It reports false when the track
// was closed first or already has a stream.
func (p *publication) attach(remote *webrtc.TrackRemote) bool {
	if !p.remote.CompareAndSwap(nil, remote) {
		return false
	}
	if p.closed.Load() {
		_ = remote.SetReadDeadline(time.Now())
		return false
	}
	return true
}

// forward copies the publisher's RTP to subscribers until the track closes.
// Header extensions are dropped: their IDs are negotiated per connection.
func (p *publication) forward(remote *webrtc.TrackRemote) {
	for {
		packet, _, err := remote.ReadRTP()
		if err != nil || p.closed.Load() {
			return
		}
		p.lastRTP.Store(time.Now().UnixNano())
		packet.Extension = false
		packet.Extensions = nil
		// A subscriber's write failure must not stop the publisher's other subscribers.
		_ = p.local.WriteRTP(packet)
	}
}

// close stops forwarding. Subscribers keep their senders but receive nothing more.
func (p *publication) close() {
	p.closed.Store(true)
	if p.source == sourceScreen {
		p.session.node.releaseScreen(p.session)
	}
	if remote := p.remote.Load(); remote != nil {
		_ = remote.SetReadDeadline(time.Now())
	}
}

func (p *publication) active(now time.Time) bool {
	last := p.lastRTP.Load()
	return !p.closed.Load() && last != 0 && now.Sub(time.Unix(0, last)) < activeWindow
}

// requestKeyframe asks the publisher for a keyframe, at most once per interval.
func (p *publication) requestKeyframe() {
	remote := p.remote.Load()
	if remote == nil || p.closed.Load() || remote.Kind() != webrtc.RTPCodecTypeVideo {
		return
	}
	now := time.Now().UnixNano()
	last := p.lastAsked.Load()
	if now-last < int64(keyframeInterval) || !p.lastAsked.CompareAndSwap(last, now) {
		return
	}
	_ = p.session.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(remote.SSRC())}})
}

// subscription is one session's pull of a publication.
type subscription struct {
	pub         *publication
	transceiver *webrtc.RTPTransceiver
	sender      *webrtc.RTPSender
	mid         string
	closed      atomic.Bool
	// ceiling is the layer the subscriber last asked for through UpdateTracks.
	ceiling atomic.Pointer[string]
}

// readFeedback relays the subscriber's keyframe requests until its sender stops.
// Pion also needs this read to run its RTCP interceptors.
func (s *subscription) readFeedback() {
	for {
		packets, _, err := s.sender.ReadRTCP()
		if err != nil {
			return
		}
		if s.closed.Load() {
			continue
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				s.pub.requestKeyframe()
			}
		}
	}
}

// close stops the subscription's transceiver and sender. That ends the RTCP reader, unbinds
// the publisher's track from the sender and frees the sender's SRTP stream. It is idempotent.
func (s *subscription) close() {
	if !s.closed.CompareAndSwap(false, true) {
		return
	}
	if err := s.transceiver.Stop(); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		s.pub.session.node.log.Warn("stop subscription", "connectionId", s.pub.session.id, "error", err)
	}
}
