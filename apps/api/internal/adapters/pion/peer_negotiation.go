package pion

import (
	"context"
	"fmt"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// NegotiationResult carries the local description produced while consuming a
// provider negotiation. For OfferNeeded, Negotiation is the outbound local
// offer. For AnswerNeeded, LocalDescription is the answer to send upstream.
type NegotiationResult struct {
	LocalDescription *captureplane.Description
	Negotiation      captureplane.Negotiation
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

func (p *Peer) createOfferResult(ctx context.Context, providerNegotiationID captureplane.ProviderReference) (NegotiationResult, error) {
	offer, err := p.CreateLocalOffer(ctx, providerNegotiationID)
	if err != nil {
		return NegotiationResult{}, err
	}
	return NegotiationResult{LocalDescription: offer.Description, Negotiation: offer}, nil
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

func newRecorderAPI() (*webrtc.API, error) {
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register recorder Opus codec: %w", err)
	}
	feedback := []webrtc.RTCPFeedback{{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"}, {Type: "nack"}, {Type: "nack", Parameter: "pli"}}
	// Capture observed RTX replaying video at unrelated original sequence positions.
	// Negotiate primary video only; keep NACK and PLI feedback for loss recovery.
	codecs := []webrtc.RTPCodecParameters{
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000, RTCPFeedback: feedback}, PayloadType: 96},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90_000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", RTCPFeedback: feedback}, PayloadType: 102},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90_000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f", RTCPFeedback: feedback}, PayloadType: 104},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90_000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", RTCPFeedback: feedback}, PayloadType: 106},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90_000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f", RTCPFeedback: feedback}, PayloadType: 108},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90_000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f", RTCPFeedback: feedback}, PayloadType: 127},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90_000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=4d001f", RTCPFeedback: feedback}, PayloadType: 39},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90_000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f", RTCPFeedback: feedback}, PayloadType: 112},
	}
	for _, codec := range codecs {
		if err := mediaEngine.RegisterCodec(codec, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, fmt.Errorf("register recorder video codec: %w", err)
		}
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, fmt.Errorf("register recorder RTP interceptors: %w", err)
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry)), nil
}
