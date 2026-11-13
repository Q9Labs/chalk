package pion

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// RegisterTracks replaces the current expected track set before the next SDP
// operation. A provider may reuse a MID for a replacement publication; in that
// case the old remote binding is removed so WaitForTrack cannot return it.
func (p *Peer) RegisterTracks(tracks []captureplane.PulledCaptureTrack) error {
	if p == nil {
		return ErrPeerClosed
	}
	p.commandMu.Lock()
	defer p.commandMu.Unlock()
	if err := p.checkUsableLocked(); err != nil {
		return err
	}
	if len(tracks) > maxMediaTracks {
		return fmt.Errorf("%w: maximum %d tracks", captureplane.ErrInvalidTrack, maxMediaTracks)
	}
	seen := make(map[string]struct{}, len(tracks))
	for _, track := range tracks {
		if err := track.Validate(); err != nil {
			return fmt.Errorf("%w: %w", captureplane.ErrInvalidTrack, err)
		}
		mid := strings.TrimSpace(string(track.MID))
		if _, exists := seen[mid]; exists {
			return fmt.Errorf("%w: %s", ErrDuplicateMID, mid)
		}
		seen[mid] = struct{}{}
	}

	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	next := make(map[string]captureplane.PulledCaptureTrack, len(tracks))
	for _, track := range tracks {
		mid := string(track.MID)
		next[mid] = track
		p.knownMIDs[mid] = struct{}{}
	}
	for mid, bound := range p.tracks {
		expected, active := next[mid]
		if !active || !sameTrackIdentity(bound.identity, expected) {
			delete(p.tracks, mid)
		}
	}
	p.expected = next
	p.registeredTracks = append(p.registeredTracks[:0], tracks...)
	sort.Slice(p.registeredTracks, func(i, j int) bool { return p.registeredTracks[i].MID < p.registeredTracks[j].MID })
	p.registered = true
	p.signalLocked()
	return nil
}

// RegisterCaptureTracks is a vocabulary alias for RegisterTracks.
func (p *Peer) RegisterCaptureTracks(tracks []captureplane.PulledCaptureTrack) error {
	return p.RegisterTracks(tracks)
}

// Tracks returns a deterministic snapshot of tracks bound by OnTrack.
func (p *Peer) Tracks() []*MediaTrack {
	if p == nil {
		return nil
	}
	p.stateMu.RLock()
	tracks := make([]*MediaTrack, 0, len(p.tracks))
	for _, track := range p.tracks {
		tracks = append(tracks, track)
	}
	p.stateMu.RUnlock()
	sort.Slice(tracks, func(i, j int) bool { return tracks[i].MID() < tracks[j].MID() })
	return tracks
}

// Track returns a bound track by negotiated MID.
func (p *Peer) Track(mid captureplane.ProviderReference) (*MediaTrack, bool) {
	if p == nil {
		return nil, false
	}
	p.stateMu.RLock()
	track, ok := p.tracks[string(mid)]
	p.stateMu.RUnlock()
	return track, ok
}

// WaitForTrack waits until OnTrack binds mid, the peer becomes terminal, or
// ctx expires. The returned wrapper is safe for later RTP reads.
func (p *Peer) WaitForTrack(ctx context.Context, mid captureplane.ProviderReference) (*MediaTrack, error) {
	if p == nil {
		return nil, ErrPeerClosed
	}
	for {
		// Subscribe before checking state so a concurrent binding cannot be missed.
		p.stateMu.RLock()
		notify := p.notify
		p.stateMu.RUnlock()
		if track, ok := p.Track(mid); ok {
			return track, nil
		}
		if err := p.Error(); err != nil {
			return nil, err
		}
		if err := p.checkContext(ctx); err != nil {
			return nil, err
		}
		select {
		case <-notify:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// RequestKeyFrame sends a PLI for the currently bound video track. Capture
// calls this when a source is first bound or replaced so retained RTP does not
// depend on an arbitrary pre-capture reference frame.
func (p *Peer) RequestKeyFrame(mid captureplane.ProviderReference) error {
	if p == nil {
		return ErrPeerClosed
	}
	p.stateMu.RLock()
	track := p.tracks[string(mid)]
	closed := p.closed
	p.stateMu.RUnlock()
	if closed {
		return ErrPeerClosed
	}
	if track == nil || track.remote == nil {
		return fmt.Errorf("%w: %s", ErrTrackNotBound, mid)
	}
	if track.identity.Kind != captureplane.TrackKindVideo {
		return nil
	}
	if err := p.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.remote.SSRC())}}); err != nil {
		return fmt.Errorf("%w: %w", ErrKeyFrameRequest, err)
	}
	return nil
}

func (p *Peer) addTransceiversLocked() error {
	tracks := append([]captureplane.PulledCaptureTrack(nil), p.registeredTracks...)
	for _, track := range tracks {
		if p.hasTransceiverMID(string(track.MID)) {
			continue
		}
		kind := webrtc.RTPCodecTypeAudio
		if track.Kind == captureplane.TrackKindVideo {
			kind = webrtc.RTPCodecTypeVideo
		}
		if _, err := p.pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			return fmt.Errorf("add %s receiver for MID %s: %w", track.Kind, track.MID, err)
		}
	}
	return nil
}

func (p *Peer) hasTransceiverMID(mid string) bool {
	for _, transceiver := range p.pc.GetTransceivers() {
		if strings.TrimSpace(transceiver.Mid()) == mid {
			return true
		}
	}
	return false
}

func (p *Peer) validateTransceiverMIDs() error {
	for _, transceiver := range p.pc.GetTransceivers() {
		mid := strings.TrimSpace(transceiver.Mid())
		if mid == "" {
			continue
		}
		if _, ok := p.knownMIDs[mid]; !ok {
			return fmt.Errorf("%w: %s", ErrUnknownMID, mid)
		}
	}
	return nil
}

func (p *Peer) bindTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if remote == nil || receiver == nil || receiver.RTPTransceiver() == nil {
		p.bindingErr = errors.Join(p.bindingErr, ErrTrackBinding)
		p.signalLocked()
		return
	}
	mid := strings.TrimSpace(receiver.RTPTransceiver().Mid())
	identity, ok := p.expected[mid]
	if !ok {
		// OnTrack can race a provider-confirmed removal. A MID that was
		// previously registered but is no longer active is stale media, not a
		// terminal protocol violation for the replacement binding.
		if _, known := p.knownMIDs[mid]; known {
			return
		}
		p.bindingErr = errors.Join(p.bindingErr, fmt.Errorf("%w: %s", ErrUnknownMID, mid))
		p.signalLocked()
		return
	}
	p.tracks[mid] = &MediaTrack{identity: identity, mid: captureplane.ProviderReference(mid), rid: remote.RID(), remote: remote, receiver: receiver, boundAt: time.Now()}
	p.signalLocked()
}

func sameTrackIdentity(left, right captureplane.PulledCaptureTrack) bool {
	return left.MID == right.MID &&
		left.OwnerReference == right.OwnerReference &&
		left.TrackReference == right.TrackReference &&
		left.ParticipantID == right.ParticipantID &&
		left.ParticipantGeneration == right.ParticipantGeneration &&
		left.Source == right.Source &&
		left.Kind == right.Kind
}
