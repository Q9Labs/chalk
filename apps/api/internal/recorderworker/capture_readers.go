package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

type captureRuntimeEvent struct {
	mid    string
	track  CaptureMediaTrack
	packet *rtp.Packet
	report *rtcp.SenderReport
	at     time.Time
	err    error
}

func startCaptureReaders(ctx context.Context, peer CapturePeer, tracks map[string]CaptureMediaTrack, deadline, keyFrameInterval time.Duration, events chan<- captureRuntimeEvent, firstPacketAt map[string]time.Time) (map[string]func(), func(), error) {
	if len(tracks) == 0 {
		return make(map[string]func()), func() {}, nil
	}
	readerCtx, cancel := context.WithCancel(ctx)
	cancels := make(map[string]func(), len(tracks))
	for mid, track := range tracks {
		readerCancel, err := startCaptureReader(readerCtx, peer, mid, track, deadline, keyFrameInterval, events, firstPacketAt[mid])
		if err != nil {
			cancel()
			for _, stop := range cancels {
				stop()
			}
			return nil, nil, err
		}
		cancels[mid] = readerCancel
	}
	return cancels, func() {
		cancel()
		for _, stop := range cancels {
			stop()
		}
	}, nil
}

// startCaptureReader stamps the first packet with firstPacketAt when it is set
// and earlier than the read. A late track passes the time the peer bound it, so
// the track's clock keeps its place however long the loop was busy.
func startCaptureReader(ctx context.Context, peer CapturePeer, mid string, track CaptureMediaTrack, deadline, keyFrameInterval time.Duration, events chan<- captureRuntimeEvent, firstPacketAt time.Time) (func(), error) {
	if peer == nil || track == nil || strings.TrimSpace(mid) == "" || deadline <= 0 {
		return nil, ErrInvalidCaptureAttempt
	}
	readerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	video := track.CaptureTrack().Kind == captureplane.TrackKindVideo
	stamped := false
	stopReports := startCaptureSenderReports(readerCtx, mid, track, deadline, events)
	go func() {
		defer close(done)
		defer cancel()
		defer func() {
			if recover() != nil {
				sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: capturePanicError()})
			}
		}()
		lossFeedback := captureVideoLossFeedback{interval: keyFrameInterval}
		var packetWindow capturePacketWindow
		var replayWindow captureVideoReplayWindow
		for {
			if err := readerCtx.Err(); err != nil {
				return
			}
			if err := track.SetReadDeadline(time.Now().Add(deadline)); err != nil {
				sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: err})
				return
			}
			packet, _, err := track.ReadRTP()
			if err != nil {
				if isCaptureReadTimeout(err) {
					if peerErr := peer.Error(); peerErr != nil {
						sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: errors.Join(ErrCapturePeerTerminal, peerErr)})
						return
					}
					continue
				}
				sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: err})
				return
			}
			if packet == nil {
				sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: errors.New("capture RTP reader returned nil packet")})
				return
			}
			receivedAt := time.Now()
			if !stamped {
				stamped = true
				if !firstPacketAt.IsZero() && firstPacketAt.Before(receivedAt) {
					receivedAt = firstPacketAt
				}
			}
			if !packetWindow.accept(packet.SSRC, packet.SequenceNumber) {
				continue
			}
			if video && lossFeedback.Observe(packet.SSRC, packet.SequenceNumber, receivedAt) {
				if err := peer.RequestKeyFrame(captureplane.ProviderReference(mid)); err != nil {
					sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: fmt.Errorf("request keyframe after RTP loss for capture MID %s: %w", mid, err)})
					return
				}
			}
			// Observe transport continuity before discarding media replays, so
			// their sequence numbers do not create artificial loss feedback.
			if video && !replayWindow.accept(packet, packet.SequenceNumber == packetWindow.sequence.last) {
				continue
			}
			if err := sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, packet: packet, at: receivedAt.UTC()}); err != nil {
				return
			}
		}
	}()
	return func() {
		cancel()
		<-done
		stopReports()
	}, nil
}

type captureVideoLossFeedback struct {
	sequence         rtpSequenceExtender
	ssrc             uint32
	initialized      bool
	next             uint64
	highest          uint64
	received         map[uint64]struct{}
	lastKeyFrameTime time.Time
	pending          bool
	// interval, when set, also asks for a keyframe once this long has passed
	// since the last request, loss or not.
	interval time.Duration
}

func (f *captureVideoLossFeedback) Observe(ssrc uint32, sequence uint16, now time.Time) bool {
	if !f.initialized || f.ssrc != ssrc {
		*f = captureVideoLossFeedback{ssrc: ssrc, initialized: true, interval: f.interval}
		if f.interval > 0 {
			// Binding a sender already requested a keyframe; the interval counts from here.
			f.lastKeyFrameTime = now
		}
		extended := f.sequence.Extend(sequence)
		f.next = extended + 1
		f.highest = extended
		return false
	}
	extended := f.sequence.Extend(sequence)
	if extended < f.next {
		return false
	}
	if f.received == nil {
		f.received = make(map[uint64]struct{}, captureVideoReorderWindow)
	}
	f.received[extended] = struct{}{}
	f.highest = max(f.highest, extended)
	for {
		if _, ok := f.received[f.next]; !ok {
			break
		}
		delete(f.received, f.next)
		f.next++
	}
	if f.next <= f.highest && f.highest-f.next >= captureVideoReorderWindow {
		f.next = f.highest + 1
		clear(f.received)
		f.pending = true
	}
	if f.interval > 0 && !now.Before(f.lastKeyFrameTime.Add(f.interval)) {
		f.pending = true
	}
	if !f.pending || (!f.lastKeyFrameTime.IsZero() && now.Before(f.lastKeyFrameTime.Add(captureKeyFrameRequestSpacing))) {
		return false
	}
	f.pending = false
	f.lastKeyFrameTime = now
	return true
}

func sendCaptureRuntimeEvent(ctx context.Context, events chan<- captureRuntimeEvent, event captureRuntimeEvent) error {
	select {
	case events <- event:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func isCaptureReadTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

type capturePionPeer struct{ *pion.Peer }

func (p *capturePionPeer) WaitForTrack(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
	track, err := p.Peer.WaitForTrack(ctx, mid)
	if err != nil {
		return nil, err
	}
	return track, nil
}

type rtpSequenceExtender struct {
	initialized bool
	last        uint16
	highest     uint64
}

func (e *rtpSequenceExtender) Extend(sequence uint16) uint64 {
	if e == nil {
		return uint64(sequence)
	}
	if !e.initialized {
		e.initialized = true
		e.last = sequence
		e.highest = uint64(sequence)
		return e.highest
	}
	cycle := e.highest >> 16
	candidate := (cycle << 16) | uint64(sequence)
	if sequence < e.last && e.last-sequence > 0x8000 {
		candidate += 1 << 16
	}
	if sequence > e.last && sequence-e.last > 0x8000 {
		if cycle == 0 {
			return uint64(sequence)
		}
		candidate -= 1 << 16
	}
	if candidate > e.highest {
		e.highest = candidate
		e.last = sequence
	}
	return candidate
}
