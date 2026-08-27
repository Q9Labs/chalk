// Package pion owns the WebRTC peer connection used by a recording capture
// worker. The package deliberately exposes only provider-neutral signaling and
// Chalk track identity; Cloudflare and other SFU adapters stay outside it.
package pion

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

const maxMediaTracks = captureplane.MaxCaptureTracks

var (
	ErrInvalidCaptureEpoch   = errors.New("pion capture epoch must be positive")
	ErrPeerClosed            = errors.New("pion peer connection is closed")
	ErrPeerTerminal          = errors.New("pion peer connection is terminal")
	ErrTracksNotRegistered   = errors.New("pion expected tracks are not registered")
	ErrTrackIdentityMutation = errors.New("pion track identity changed for an existing MID")
	ErrUnknownMID            = errors.New("pion received an unknown MID")
	ErrDuplicateMID          = errors.New("pion received a duplicate MID")
	ErrInvalidNegotiation    = errors.New("pion negotiation is invalid")
	ErrStaleNegotiation      = errors.New("pion negotiation is stale")
	ErrNegotiationPending    = errors.New("pion negotiation is already pending")
	ErrTrackBinding          = errors.New("pion track binding failed")
)

// Config creates one peer connection for one capture epoch. API is optional;
// tests can provide a configured Pion API while production uses the defaults.
type Config struct {
	CaptureEpoch  captureplane.CaptureEpoch
	Configuration webrtc.Configuration
	API           *webrtc.API
}

// Peer owns a single serialized PeerConnection. A reconnect is a worker
// concern: this object never creates another connection or changes its epoch.
type Peer struct {
	commandMu sync.Mutex
	stateMu   sync.RWMutex

	epoch captureplane.CaptureEpoch
	pc    *webrtc.PeerConnection

	registered       bool
	registeredTracks []captureplane.PulledCaptureTrack
	expected         map[string]captureplane.PulledCaptureTrack

	tracks        map[string]*MediaTrack
	bindingErr    error
	terminalErr   error
	terminalState webrtc.PeerConnectionState
	pendingOffer  bool
	closed        bool
	notify        chan struct{}
}

// PeerState is the provider-neutral projection of Pion's terminal state.
type PeerState string

const (
	PeerStateNew          PeerState = "new"
	PeerStateConnecting   PeerState = "connecting"
	PeerStateConnected    PeerState = "connected"
	PeerStateDisconnected PeerState = "disconnected"
	PeerStateFailed       PeerState = "failed"
	PeerStateClosed       PeerState = "closed"
)

// NegotiationResult carries the local description produced while consuming a
// provider negotiation. For OfferNeeded, Negotiation is the outbound local
// offer. For AnswerNeeded, LocalDescription is the answer to send upstream.
type NegotiationResult struct {
	LocalDescription *captureplane.Description
	Negotiation      captureplane.Negotiation
}

// MediaTrack retains the authenticated Chalk track and exposes only bounded
// RTP reads from Pion's remote track. It does not buffer packets in memory.
type MediaTrack struct {
	identity captureplane.PulledCaptureTrack
	mid      captureplane.ProviderReference
	rid      string
	remote   *webrtc.TrackRemote
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

// NewPeer creates exactly one PeerConnection for config.CaptureEpoch.
func NewPeer(config Config) (*Peer, error) {
	if config.CaptureEpoch == 0 {
		return nil, ErrInvalidCaptureEpoch
	}
	api := config.API
	if api == nil {
		api = webrtc.NewAPI()
	}
	pc, err := api.NewPeerConnection(config.Configuration)
	if err != nil {
		return nil, fmt.Errorf("create Pion peer connection: %w", err)
	}

	peer := &Peer{
		epoch:    config.CaptureEpoch,
		pc:       pc,
		expected: make(map[string]captureplane.PulledCaptureTrack),
		tracks:   make(map[string]*MediaTrack),
		notify:   make(chan struct{}),
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		peer.stateMu.Lock()
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			peer.terminalState = state
			if peer.terminalErr == nil {
				peer.terminalErr = fmt.Errorf("%w: %s", ErrPeerTerminal, state)
			}
		}
		peer.signalLocked()
		peer.stateMu.Unlock()
	})
	pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		peer.bindTrack(remote, receiver)
	})
	return peer, nil
}

// NewPeerConnection is an explicit alias for callers that use the Pion
// terminology while keeping NewPeer convenient for the capture worker.
func NewPeerConnection(config Config) (*Peer, error) { return NewPeer(config) }

// Epoch returns the immutable capture epoch owned by this peer.
func (p *Peer) Epoch() captureplane.CaptureEpoch {
	if p == nil {
		return 0
	}
	return p.epoch
}

// ConnectionState returns Pion's current connection state.
func (p *Peer) ConnectionState() webrtc.PeerConnectionState {
	if p == nil || p.pc == nil {
		return webrtc.PeerConnectionStateClosed
	}
	return p.pc.ConnectionState()
}

// State projects the Pion state into a provider-neutral bounded vocabulary.
func (p *Peer) State() PeerState {
	switch p.ConnectionState() {
	case webrtc.PeerConnectionStateNew:
		return PeerStateNew
	case webrtc.PeerConnectionStateConnecting:
		return PeerStateConnecting
	case webrtc.PeerConnectionStateConnected:
		return PeerStateConnected
	case webrtc.PeerConnectionStateDisconnected:
		return PeerStateDisconnected
	case webrtc.PeerConnectionStateFailed:
		return PeerStateFailed
	case webrtc.PeerConnectionStateClosed:
		return PeerStateClosed
	default:
		return PeerStateNew
	}
}

// TerminalState reports whether this peer has reached a state that requires a
// worker-level new capture epoch. The peer itself never creates that epoch.
func (p *Peer) TerminalState() (webrtc.PeerConnectionState, bool) {
	if p == nil {
		return webrtc.PeerConnectionStateClosed, true
	}
	p.stateMu.RLock()
	state := p.terminalState
	p.stateMu.RUnlock()
	return state, state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed
}

// Error reports asynchronous track-binding or terminal connection failure.
func (p *Peer) Error() error {
	if p == nil {
		return ErrPeerClosed
	}
	p.stateMu.RLock()
	defer p.stateMu.RUnlock()
	return errors.Join(p.bindingErr, p.terminalErr)
}

// RegisterTracks reconciles expected tracks by MID before the next SDP
// operation. Re-registering an identical track is idempotent; an existing MID
// may only receive a layer-policy update, never a new publication identity.
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
	if p.expected == nil {
		p.expected = make(map[string]captureplane.PulledCaptureTrack, len(tracks))
	}
	postReconcileCount := len(p.expected)
	for _, track := range tracks {
		mid := string(track.MID)
		existing, exists := p.expected[mid]
		if exists && !sameTrackIdentity(existing, track) {
			return fmt.Errorf("%w: %s", ErrTrackIdentityMutation, mid)
		}
		if !exists {
			postReconcileCount++
		}
	}
	if postReconcileCount > maxMediaTracks {
		return fmt.Errorf("%w: maximum %d tracks", captureplane.ErrInvalidTrack, maxMediaTracks)
	}
	for _, track := range tracks {
		mid := string(track.MID)
		_, exists := p.expected[mid]
		p.expected[mid] = track
		if exists {
			for index := range p.registeredTracks {
				if p.registeredTracks[index].MID == track.MID {
					p.registeredTracks[index] = track
					break
				}
			}
			continue
		}
		p.registeredTracks = append(p.registeredTracks, track)
	}
	p.registered = true
	return nil
}

// RegisterCaptureTracks is a vocabulary alias for RegisterTracks.
func (p *Peer) RegisterCaptureTracks(tracks []captureplane.PulledCaptureTrack) error {
	return p.RegisterTracks(tracks)
}

// CreateLocalOffer creates a non-trickle local offer and records one pending
// answer fence. A second offer cannot replace the pending one on this epoch.
func (p *Peer) CreateLocalOffer(ctx context.Context, providerNegotiationID ...captureplane.ProviderReference) (captureplane.Negotiation, error) {
	if p == nil {
		return captureplane.Negotiation{}, ErrPeerClosed
	}
	p.commandMu.Lock()
	defer p.commandMu.Unlock()
	if err := p.checkContext(ctx); err != nil {
		return captureplane.Negotiation{}, err
	}
	if err := p.checkUsableLocked(); err != nil {
		return captureplane.Negotiation{}, err
	}
	if !p.registered {
		return captureplane.Negotiation{}, ErrTracksNotRegistered
	}
	if len(providerNegotiationID) > 1 {
		return captureplane.Negotiation{}, fmt.Errorf("%w: one provider negotiation ID is required", ErrInvalidNegotiation)
	}
	if len(providerNegotiationID) == 0 || providerNegotiationID[0].IsZero() {
		return captureplane.Negotiation{}, fmt.Errorf("%w: provider negotiation ID is required", ErrInvalidNegotiation)
	}
	if p.pendingOffer {
		return captureplane.Negotiation{}, ErrNegotiationPending
	}
	if err := p.addTransceiversLocked(); err != nil {
		return captureplane.Negotiation{}, err
	}
	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		return captureplane.Negotiation{}, fmt.Errorf("create local offer: %w", err)
	}
	if err := p.validateTransceiverMIDs(); err != nil {
		return captureplane.Negotiation{}, err
	}
	gatherComplete := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(offer); err != nil {
		return captureplane.Negotiation{}, fmt.Errorf("set local offer: %w", err)
	}
	if err := p.validateTransceiverMIDs(); err != nil {
		return captureplane.Negotiation{}, err
	}
	if err := waitGathering(ctx, gatherComplete); err != nil {
		return captureplane.Negotiation{}, err
	}
	description, err := localDescription(p.pc)
	if err != nil {
		return captureplane.Negotiation{}, err
	}
	p.pendingOffer = true
	negotiation := captureplane.Negotiation{
		ID:          providerNegotiationID[0],
		Requirement: captureplane.NegotiationOfferNeeded,
		Description: &description,
	}
	if err := negotiation.Validate(); err != nil {
		return captureplane.Negotiation{}, fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
	}
	return negotiation, nil
}

// CreateOffer is a short alias used by capture workers.
func (p *Peer) CreateOffer(ctx context.Context, providerNegotiationID ...captureplane.ProviderReference) (captureplane.Negotiation, error) {
	return p.CreateLocalOffer(ctx, providerNegotiationID...)
}

// AnswerRemoteOffer applies an SFU offer and creates a non-trickle local
// answer. Expected tracks were registered before SetRemoteDescription.
func (p *Peer) AnswerRemoteOffer(ctx context.Context, negotiation captureplane.Negotiation) (captureplane.Description, error) {
	if p == nil {
		return captureplane.Description{}, ErrPeerClosed
	}
	p.commandMu.Lock()
	defer p.commandMu.Unlock()
	if err := p.checkContext(ctx); err != nil {
		return captureplane.Description{}, err
	}
	if err := validateOfferNegotiation(negotiation); err != nil {
		return captureplane.Description{}, err
	}
	if err := p.checkUsableLocked(); err != nil {
		return captureplane.Description{}, err
	}
	if !p.registered {
		return captureplane.Description{}, ErrTracksNotRegistered
	}
	if p.pendingOffer {
		return captureplane.Description{}, ErrNegotiationPending
	}
	remote, err := toPionDescription(*negotiation.Description)
	if err != nil {
		return captureplane.Description{}, err
	}
	if err := p.pc.SetRemoteDescription(remote); err != nil {
		return captureplane.Description{}, fmt.Errorf("set remote offer: %w", err)
	}
	if err := p.validateTransceiverMIDs(); err != nil {
		return captureplane.Description{}, err
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return captureplane.Description{}, fmt.Errorf("create local answer: %w", err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(answer); err != nil {
		return captureplane.Description{}, fmt.Errorf("set local answer: %w", err)
	}
	if err := waitGathering(ctx, gatherComplete); err != nil {
		return captureplane.Description{}, err
	}
	return localDescription(p.pc)
}

// AcceptOffer is a vocabulary alias for AnswerRemoteOffer.
func (p *Peer) AcceptOffer(ctx context.Context, negotiation captureplane.Negotiation) (captureplane.Description, error) {
	return p.AnswerRemoteOffer(ctx, negotiation)
}

// ApplyRemoteAnswer applies the terminal remote_answer produced for the
// pending local offer. It never creates a new capture epoch or SDP offer.
func (p *Peer) ApplyRemoteAnswer(ctx context.Context, negotiation captureplane.Negotiation) error {
	if p == nil {
		return ErrPeerClosed
	}
	p.commandMu.Lock()
	defer p.commandMu.Unlock()
	if err := p.checkContext(ctx); err != nil {
		return err
	}
	if negotiation.Requirement != captureplane.NegotiationRemoteAnswer || negotiation.Description == nil || !negotiation.ID.IsZero() {
		return fmt.Errorf("%w: remote answer is required", ErrInvalidNegotiation)
	}
	if err := negotiation.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
	}
	if err := p.checkUsableLocked(); err != nil {
		return err
	}
	if !p.pendingOffer {
		return ErrStaleNegotiation
	}
	remote, err := toPionDescription(*negotiation.Description)
	if err != nil {
		return err
	}
	if err := p.pc.SetRemoteDescription(remote); err != nil {
		return fmt.Errorf("set remote answer: %w", err)
	}
	p.pendingOffer = false
	return nil
}

// Handle applies one provider-neutral negotiation and returns the local
// description needed by the worker. AnswerNeeded produces a local answer;
// OfferNeeded produces a fenced local offer; remote_answer is terminal.
func (p *Peer) Handle(ctx context.Context, negotiation captureplane.Negotiation) (NegotiationResult, error) {
	if err := negotiation.Validate(); err != nil {
		return NegotiationResult{}, fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
	}
	switch negotiation.Requirement {
	case captureplane.NegotiationAnswerNeeded:
		answer, err := p.AnswerRemoteOffer(ctx, negotiation)
		if err != nil {
			return NegotiationResult{}, err
		}
		return NegotiationResult{LocalDescription: &answer, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
	case captureplane.NegotiationOfferNeeded:
		return p.createOfferResult(ctx, negotiation.ID)
	case captureplane.NegotiationRemoteAnswer:
		if err := p.ApplyRemoteAnswer(ctx, negotiation); err != nil {
			return NegotiationResult{}, err
		}
		return NegotiationResult{Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
	case captureplane.NegotiationNotRequired:
		return NegotiationResult{Negotiation: negotiation}, nil
	default:
		return NegotiationResult{}, fmt.Errorf("%w: %s", ErrInvalidNegotiation, negotiation.Requirement)
	}
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
	for {
		if track, ok := p.Track(mid); ok {
			return track, nil
		}
		if err := p.Error(); err != nil {
			return nil, err
		}
		if err := p.checkContext(ctx); err != nil {
			return nil, err
		}
		p.stateMu.RLock()
		notify := p.notify
		p.stateMu.RUnlock()
		select {
		case <-notify:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Close closes this epoch's sole PeerConnection. It is idempotent.
func (p *Peer) Close() error {
	if p == nil {
		return nil
	}
	p.commandMu.Lock()
	defer p.commandMu.Unlock()
	p.stateMu.Lock()
	if p.closed {
		p.stateMu.Unlock()
		return nil
	}
	p.closed = true
	p.stateMu.Unlock()
	if err := p.pc.Close(); err != nil {
		return fmt.Errorf("close Pion peer connection: %w", err)
	}
	return nil
}

func (p *Peer) createOfferResult(ctx context.Context, providerNegotiationID captureplane.ProviderReference) (NegotiationResult, error) {
	offer, err := p.CreateLocalOffer(ctx, providerNegotiationID)
	if err != nil {
		return NegotiationResult{}, err
	}
	return NegotiationResult{LocalDescription: offer.Description, Negotiation: offer}, nil
}

func (p *Peer) checkUsableLocked() error {
	p.stateMu.RLock()
	closed := p.closed
	terminalErr := p.terminalErr
	p.stateMu.RUnlock()
	if closed {
		return ErrPeerClosed
	}
	if terminalErr != nil {
		return terminalErr
	}
	return nil
}

func (p *Peer) checkContext(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
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
		if _, ok := p.expected[mid]; !ok {
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
		p.bindingErr = errors.Join(p.bindingErr, fmt.Errorf("%w: %s", ErrUnknownMID, mid))
		p.signalLocked()
		return
	}
	if _, exists := p.tracks[mid]; exists {
		p.bindingErr = errors.Join(p.bindingErr, fmt.Errorf("%w: %s", ErrDuplicateMID, mid))
		p.signalLocked()
		return
	}
	p.tracks[mid] = &MediaTrack{identity: identity, mid: captureplane.ProviderReference(mid), rid: remote.RID(), remote: remote}
	p.signalLocked()
}

func (p *Peer) signalLocked() {
	close(p.notify)
	p.notify = make(chan struct{})
}

func validateOfferNegotiation(negotiation captureplane.Negotiation) error {
	if negotiation.Requirement != captureplane.NegotiationAnswerNeeded || negotiation.Description == nil || negotiation.Description.Type != "offer" {
		return fmt.Errorf("%w: answer-needed offer required", ErrInvalidNegotiation)
	}
	if err := negotiation.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
	}
	return nil
}

type pionDescription = webrtc.SessionDescription

func toPionDescription(description captureplane.Description) (pionDescription, error) {
	if err := description.Validate(); err != nil {
		return pionDescription{}, fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
	}
	var kind webrtc.SDPType
	switch description.Type {
	case "offer":
		kind = webrtc.SDPTypeOffer
	case "answer":
		kind = webrtc.SDPTypeAnswer
	case "pranswer":
		kind = webrtc.SDPTypePranswer
	case "rollback":
		kind = webrtc.SDPTypeRollback
	default:
		return pionDescription{}, fmt.Errorf("%w: unsupported SDP type %q", ErrInvalidNegotiation, description.Type)
	}
	return pionDescription{Type: kind, SDP: description.SDP}, nil
}

func localDescription(pc *webrtc.PeerConnection) (captureplane.Description, error) {
	description := pc.LocalDescription()
	if description == nil {
		return captureplane.Description{}, fmt.Errorf("%w: Pion local description is missing", ErrInvalidNegotiation)
	}
	var kind string
	switch description.Type {
	case webrtc.SDPTypeOffer:
		kind = "offer"
	case webrtc.SDPTypeAnswer:
		kind = "answer"
	case webrtc.SDPTypePranswer:
		kind = "pranswer"
	case webrtc.SDPTypeRollback:
		kind = "rollback"
	default:
		return captureplane.Description{}, fmt.Errorf("%w: unsupported Pion local SDP type %s", ErrInvalidNegotiation, description.Type)
	}
	converted := captureplane.Description{Type: kind, SDP: description.SDP}
	if err := converted.Validate(); err != nil {
		return captureplane.Description{}, fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
	}
	return converted, nil
}

func waitGathering(ctx context.Context, complete <-chan struct{}) error {
	if ctx == nil {
		<-complete
		return nil
	}
	select {
	case <-complete:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
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
