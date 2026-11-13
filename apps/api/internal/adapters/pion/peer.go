// Package pion owns the WebRTC peer connection used by a recording capture
// worker. The package deliberately exposes only provider-neutral signaling and
// Chalk track identity; Cloudflare and other SFU adapters stay outside it.
package pion

import (
	"context"
	"errors"
	"fmt"
	"sync"

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
	ErrTrackNotBound         = errors.New("pion capture track is not bound")
	ErrKeyFrameRequest       = errors.New("pion keyframe request failed")
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
	knownMIDs        map[string]struct{}

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

// NewPeer creates exactly one PeerConnection for config.CaptureEpoch.
func NewPeer(config Config) (*Peer, error) {
	if config.CaptureEpoch == 0 {
		return nil, ErrInvalidCaptureEpoch
	}
	api := config.API
	if api == nil {
		var err error
		api, err = newRecorderAPI()
		if err != nil {
			return nil, err
		}
	}
	pc, err := api.NewPeerConnection(config.Configuration)
	if err != nil {
		return nil, fmt.Errorf("create Pion peer connection: %w", err)
	}

	peer := &Peer{
		epoch:     config.CaptureEpoch,
		pc:        pc,
		expected:  make(map[string]captureplane.PulledCaptureTrack),
		knownMIDs: make(map[string]struct{}),
		tracks:    make(map[string]*MediaTrack),
		notify:    make(chan struct{}),
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

func (p *Peer) signalLocked() {
	close(p.notify)
	p.notify = make(chan struct{})
}
