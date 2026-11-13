package capturesignaling

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func commandFor(operation captureplane.OperationKind, expiresAt time.Time) Command {
	authority := CommandAuthority{
		TenantID: utilities.IDFromBytes([16]byte{1}), SpaceID: utilities.IDFromBytes([16]byte{2}),
		EpisodeID: utilities.IDFromBytes([16]byte{3}), RecordingID: utilities.IDFromBytes([16]byte{4}),
		JobID: utilities.IDFromBytes([16]byte{5}), AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1,
		EnvelopeDigest: func() []byte { digest := sha256.Sum256([]byte("envelope")); return digest[:] }(),
	}
	command := Command{
		SignalingHandle: signalingHandle(), Authority: authority,
		Lease:    WorkerLease{Owner: "worker-1", Token: "lease-1", ExpiresAt: expiresAt},
		Identity: CommandIdentity{Operation: operation, PlanRevision: 1, IdempotencyKey: "key-1"},
	}
	connection := captureplane.ProviderReference("connection-1")
	pulled := captureplane.PulledCaptureTrack{CaptureTrack: validTrack(6), MID: "mid-1"}
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		command.Input.CreateCaptureConnection = &captureplane.CreateCaptureConnectionInput{}
	case captureplane.OperationPullCaptureTracks:
		command.Input.PullCaptureTracks = &captureplane.PullCaptureTracksInput{Connection: connection, Tracks: []captureplane.CaptureTrack{validTrack(6)}}
	case captureplane.OperationRenegotiateCaptureConnection:
		command.Input.RenegotiateCaptureConnection = &captureplane.RenegotiateCaptureConnectionInput{Connection: connection, NegotiationID: "neg-1", Description: captureplane.Description{Type: "answer", SDP: "v=0"}}
	case captureplane.OperationInspectCaptureConnection:
		command.Input.InspectCaptureConnection = &captureplane.InspectCaptureConnectionInput{Connection: connection, Tracks: []captureplane.PulledCaptureTrack{pulled}}
	case captureplane.OperationCloseCaptureTracks:
		command.Input.CloseCaptureTracks = &captureplane.CloseCaptureTracksInput{Connection: connection, Tracks: []captureplane.PulledCaptureTrack{pulled}}
	case captureplane.OperationCloseCaptureConnection:
		command.Input.CloseCaptureConnection = &captureplane.CloseCaptureConnectionInput{Connection: connection, Tracks: []captureplane.PulledCaptureTrack{pulled}, Force: true}
	}
	return command
}

func signalingHandle() SignalingHandle {
	return SignalingHandle(utilities.IDFromBytes([16]byte{9}).String())
}

func preparedFor(command Command) PreparedCommand {
	return PreparedCommand{SignalingHandle: command.SignalingHandle, Authority: command.Authority, Identity: command.Identity, Input: command.Input}
}

func differentSignalingHandle() SignalingHandle {
	return SignalingHandle(utilities.IDFromBytes([16]byte{10}).String())
}

func validTrack(participant byte) captureplane.CaptureTrack {
	return captureplane.CaptureTrack{
		OwnerReference: "owner-1", TrackReference: captureplane.ProviderReference(fmt.Sprintf("track-%d", participant)),
		ParticipantID: utilities.IDFromBytes([16]byte{participant}), ParticipantGeneration: 1,
		Source: captureplane.TrackSourceMicrophone, Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto,
	}
}

func projectionFor(command Command, negotiation string) *ConnectionProjection {
	requirement := captureplane.NegotiationNotRequired
	if negotiation != "" {
		requirement = captureplane.NegotiationAnswerNeeded
	}
	return &ConnectionProjection{SignalingHandle: command.SignalingHandle, Connection: captureplane.CaptureConnection{ConnectionReference: "connection-1", CaptureEpoch: 1, PlanRevision: 1}, CaptureEpoch: 1, PlanRevision: 1, NegotiationID: captureplane.ProviderReference(negotiation), NegotiationRequirement: requirement}
}

type fakePlane struct {
	mu               sync.Mutex
	counts           map[captureplane.OperationKind]int
	resolveCalls     int
	resolvedIdentity captureplane.CaptureIdentity
	resolveErr       error
	badResult        bool
	closeDenied      bool
	pullNotFoundOnce bool
	pullGone         bool
	pullGoneWrong    bool
	createFailure    *captureplane.ProviderError
	onCreate         func()
}

func (p *fakePlane) Resolve(_ context.Context, identity captureplane.CaptureIdentity) (captureplane.CapturePlane, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resolveCalls++
	p.resolvedIdentity = identity
	if p.resolveErr != nil {
		return nil, p.resolveErr
	}
	return p, nil
}

func (p *fakePlane) resolved() captureplane.CaptureIdentity {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.resolvedIdentity
}

func (p *fakePlane) calls(operation captureplane.OperationKind) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.counts[operation]
}

func (p *fakePlane) count(operation captureplane.OperationKind) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.counts == nil {
		p.counts = make(map[captureplane.OperationKind]int)
	}
	p.counts[operation]++
}

func (p *fakePlane) connection() captureplane.CaptureConnection {
	epoch, plan := captureplane.CaptureEpoch(1), captureplane.PlanRevision(1)
	if p.badResult {
		epoch = 2
	}
	return captureplane.CaptureConnection{ConnectionReference: "connection-1", CaptureEpoch: epoch, PlanRevision: plan}
}

func (p *fakePlane) CreateCaptureConnection(context.Context, captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	p.count(captureplane.OperationCreateCaptureConnection)
	if p.onCreate != nil {
		p.onCreate()
	}
	if p.createFailure != nil {
		return captureplane.CreateCaptureConnectionResult{}, *p.createFailure
	}
	return captureplane.CreateCaptureConnectionResult{Connection: p.connection(), Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) PullCaptureTracks(context.Context, captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	p.count(captureplane.OperationPullCaptureTracks)
	if p.pullGone {
		return captureplane.PullCaptureTracksResult{Connection: p.connection(), Gone: []captureplane.CaptureTrack{validTrack(6)}, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
	}
	if p.pullGoneWrong {
		wrong := validTrack(6)
		wrong.TrackReference = "different-track"
		return captureplane.PullCaptureTracksResult{Connection: p.connection(), Gone: []captureplane.CaptureTrack{wrong}, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
	}
	if p.pullNotFoundOnce && p.calls(captureplane.OperationPullCaptureTracks) == 1 {
		return captureplane.PullCaptureTracksResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureNotFound, Code: "track_not_found", Retryable: true}
	}
	return captureplane.PullCaptureTracksResult{Connection: p.connection(), Tracks: []captureplane.PulledCaptureTrack{{CaptureTrack: validTrack(6), MID: "mid-1"}}, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) RenegotiateCaptureConnection(context.Context, captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	p.count(captureplane.OperationRenegotiateCaptureConnection)
	return captureplane.RenegotiateCaptureConnectionResult{Connection: p.connection(), Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) InspectCaptureConnection(context.Context, captureplane.InspectCaptureConnectionInput) (captureplane.InspectCaptureConnectionResult, error) {
	p.count(captureplane.OperationInspectCaptureConnection)
	return captureplane.InspectCaptureConnectionResult{Connection: p.connection(), State: captureplane.CaptureConnectionConnected, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) CloseCaptureTracks(context.Context, captureplane.CloseCaptureTracksInput) (captureplane.CloseCaptureTracksResult, error) {
	p.count(captureplane.OperationCloseCaptureTracks)
	return captureplane.CloseCaptureTracksResult{Connection: p.connection(), Tracks: []captureplane.PulledCaptureTrack{{CaptureTrack: validTrack(6), MID: "mid-1"}}, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) CloseCaptureConnection(context.Context, captureplane.CloseCaptureConnectionInput) (captureplane.CloseCaptureConnectionResult, error) {
	p.count(captureplane.OperationCloseCaptureConnection)
	return captureplane.CloseCaptureConnectionResult{Connection: p.connection(), Closed: !p.closeDenied}, nil
}

type memoryCommand struct {
	fingerprint [32]byte
	outcome     StoredOutcome
	inflight    bool
	claimToken  string
	retryAt     time.Time
}

type memoryPort struct {
	mu              sync.Mutex
	commands        map[CommandKey]*memoryCommand
	projection      *ConnectionProjection
	claimProjection *ConnectionProjection
	prepare         PrepareRequest
	claim           []ClaimRequest
	completion      Completion
	prepareErr      error
	busyClaims      int
	claims          int
	notBefore       bool
	notBeforeAt     time.Time
	ambiguous       bool
	failure         Failure
	releases        int
}

func newMemoryPort() *memoryPort { return &memoryPort{commands: make(map[CommandKey]*memoryCommand)} }

func (p *memoryPort) PrepareCommand(_ context.Context, request PrepareRequest) (PrepareResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.prepare = request
	if p.prepareErr != nil {
		return PrepareResult{}, p.prepareErr
	}
	command, ok := p.commands[request.Key]
	if ok {
		if command.fingerprint != request.Fingerprint {
			return PrepareResult{}, ConflictError{Operation: request.Key.Operation}
		}
		return PrepareResult{Prepared: false, Outcome: command.outcome, CurrentProjection: p.projection}, nil
	}
	p.commands[request.Key] = &memoryCommand{fingerprint: request.Fingerprint}
	return PrepareResult{Prepared: true, CurrentProjection: p.projection}, nil
}

func (p *memoryPort) ClaimCommand(_ context.Context, request ClaimRequest) (ClaimResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.claim = append(p.claim, request)
	p.claims++
	command := p.commands[request.Key]
	projection := p.projection
	if p.claimProjection != nil {
		projection = p.claimProjection
	}
	if len(command.outcome.ResultBytes) > 0 || command.outcome.ProviderFailure != nil {
		return ClaimResult{Outcome: command.outcome, CurrentProjection: projection}, nil
	}
	if command.retryAt.After(time.Now()) {
		return ClaimResult{NotBefore: command.retryAt, CurrentProjection: projection}, nil
	}
	if p.ambiguous {
		return ClaimResult{Ambiguous: true}, nil
	}
	if p.busyClaims > 0 {
		p.busyClaims--
		return ClaimResult{}, nil
	}
	if command.inflight {
		return ClaimResult{}, nil
	}
	command.inflight = true
	command.claimToken = "claim-1"
	if p.notBefore && p.notBeforeAt.IsZero() {
		p.notBeforeAt = request.ClaimedAt.Add(50 * time.Millisecond)
		return ClaimResult{Claimed: true, ClaimToken: command.claimToken, NotBefore: p.notBeforeAt, CurrentProjection: projection}, nil
	}
	return ClaimResult{Claimed: true, ClaimToken: command.claimToken, CurrentProjection: projection}, nil
}

func (p *memoryPort) ReleaseCommand(_ context.Context, release Release) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	command := p.commands[release.Key]
	if command == nil || !command.inflight || command.claimToken != release.ClaimToken {
		return ErrStaleLease
	}
	command.inflight = false
	command.claimToken = ""
	p.releases++
	return nil
}

func (p *memoryPort) CompleteCommand(_ context.Context, completion Completion) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.completion = completion
	command := p.commands[completion.Key]
	if command.claimToken != completion.ClaimToken {
		return ErrStaleLease
	}
	command.inflight = false
	command.outcome = StoredOutcome{ResultBytes: append([]byte(nil), completion.ResultBytes...)}
	if completion.Projection != nil {
		projection := *completion.Projection
		p.projection = &projection
	}
	return nil
}

func (p *memoryPort) FailCommand(_ context.Context, failure Failure) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	command := p.commands[failure.Key]
	command.inflight = false
	if failure.ProviderError.Retryable {
		command.retryAt = time.Now().Add(10 * time.Millisecond)
	} else {
		command.outcome = StoredOutcome{ProviderFailure: &failure.ProviderError}
	}
	p.failure = failure
	return nil
}

func (p *memoryPort) CheckDispatch(context.Context, Command) error { return nil }
