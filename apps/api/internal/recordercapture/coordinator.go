package recordercapture

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

const (
	DefaultMaxNegotiationRounds = 8
	MaxNegotiationRounds        = 32
)

// SignalingPort is the private six-operation signaling boundary. The
// command union carries one of the six CapturePlane operations and the
// durable implementation provides replay and fencing.
type SignalingPort interface {
	Execute(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error)
}

// PeerPort keeps Pion behind the coordinator boundary. A peer is created for
// one capture epoch and is never replaced by this package.
type PeerPort interface {
	RegisterTracks([]captureplane.PulledCaptureTrack) error
	CreateLocalOffer(context.Context, ...captureplane.ProviderReference) (captureplane.Negotiation, error)
	AnswerRemoteOffer(context.Context, captureplane.Negotiation) (captureplane.Description, error)
	ApplyRemoteAnswer(context.Context, captureplane.Negotiation) error
}

// PlanSource is the plan wait operation exposed by the recorder control-plane
// client. It is optional: callers can also pass already fetched plans to
// Bootstrap and Reconcile.
type PlanSource interface {
	WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error)
}

type Config struct {
	MaxNegotiationRounds int
	Now                  func() time.Time
}

func (c Config) maxNegotiationRounds() int {
	if c.MaxNegotiationRounds <= 0 {
		return DefaultMaxNegotiationRounds
	}
	return c.MaxNegotiationRounds
}

func (c Config) now() func() time.Time {
	if c.Now != nil {
		return c.Now
	}
	return func() time.Time { return time.Now().UTC() }
}

// Snapshot is the coordinator's active provider-track view. The slices are
// copied before they leave the coordinator.
type Snapshot struct {
	Connection   captureplane.CaptureConnection
	PlanRevision captureplane.PlanRevision
	Tracks       []captureplane.PulledCaptureTrack
}

// Coordinator owns one provider connection and serializes all SDP exchanges for
// its immutable recorder attempt authority.
type Coordinator struct {
	mu sync.Mutex

	authority    AttemptAuthority
	signaling    SignalingPort
	peer         PeerPort
	maxRounds    int
	now          func() time.Time
	bootstrapped bool
	closed       bool
	connection   captureplane.CaptureConnection
	plan         captureplan.Plan
	tracks       map[string]captureplane.PulledCaptureTrack
}

func NewCoordinator(authority AttemptAuthority, signaling SignalingPort, peer PeerPort, config Config) (*Coordinator, error) {
	if signaling == nil || peer == nil {
		return nil, fmt.Errorf("%w: signaling and peer are required", ErrInvalidAuthority)
	}
	if err := authority.commandAuthority().Validate(); err != nil {
		return nil, fmt.Errorf("%w: lease: %w", ErrInvalidAuthority, err)
	}
	if err := authority.SignalingHandle.Validate(); err != nil {
		return nil, fmt.Errorf("%w: signaling handle: %w", ErrInvalidAuthority, err)
	}
	if authority.CaptureEpoch == 0 || authority.PlanHandle == "" {
		return nil, fmt.Errorf("%w: attempt fence", ErrInvalidAuthority)
	}
	if config.MaxNegotiationRounds > MaxNegotiationRounds {
		return nil, fmt.Errorf("%w: maximum negotiation rounds is %d", ErrInvalidNegotiation, MaxNegotiationRounds)
	}
	now := config.now()
	observedAt := now().UTC()
	if err := authority.Lease.ValidateAt(observedAt); err != nil {
		return nil, fmt.Errorf("%w: lease: %w", ErrInvalidAuthority, err)
	}
	if authority.HardDeadline.IsZero() || !authority.HardDeadline.After(observedAt) {
		return nil, fmt.Errorf("%w: %w", ErrInvalidAuthority, ErrDeadlineExpired)
	}
	return &Coordinator{
		authority: authority,
		signaling: signaling,
		peer:      peer,
		maxRounds: config.maxNegotiationRounds(),
		now:       now,
		tracks:    make(map[string]captureplane.PulledCaptureTrack),
	}, nil
}

// Bootstrap creates the provider connection, pulls the plan tracks, registers
// returned MIDs, and settles all provider negotiation before returning.
func (c *Coordinator) Bootstrap(ctx context.Context, plan captureplan.Plan) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return Snapshot{}, ErrCaptureClosed
	}
	if err := c.checkDeadlineLocked(); err != nil {
		return Snapshot{}, err
	}
	if err := c.authority.validatePlan(plan); err != nil {
		return Snapshot{}, err
	}
	if c.bootstrapped {
		if c.plan.Revision() == plan.Revision() && stringFingerprint(c.plan) == stringFingerprint(plan) {
			return c.snapshotLocked(), nil
		}
		if plan.Revision() <= c.plan.Revision() {
			return Snapshot{}, staleOrConflict(c.plan, plan)
		}
		return c.reconcileLocked(ctx, plan)
	}
	if plan.Revision() != captureplane.PlanRevision(c.authority.Envelope.InitialPlanRevision) {
		return Snapshot{}, fmt.Errorf("%w: bootstrap revision %d", ErrStalePlan, plan.Revision())
	}

	metadata := c.authority.metadata(plan.Revision(), captureplane.OperationCreateCaptureConnection, stableIdempotencyKey(c.authority.CaptureEpoch, plan.Revision(), captureplane.OperationCreateCaptureConnection, "connection"))
	create, err := c.executeCreate(ctx, metadata)
	if err != nil {
		return Snapshot{}, err
	}
	if err := create.Connection.ValidateAgainst(metadata, captureplane.OperationCreateCaptureConnection); err != nil {
		return Snapshot{}, fmt.Errorf("%w: create connection fence: %w", ErrProtocol, err)
	}
	c.connection = create.Connection

	requested, err := tracksForPlan(plan)
	if err != nil {
		return Snapshot{}, err
	}
	if len(requested) == 0 {
		if err := c.settleNegotiation(ctx, plan.Revision(), c.connection.ConnectionReference, create.Negotiation, "create"); err != nil {
			return Snapshot{}, err
		}
		c.plan = plan
		c.bootstrapped = true
		return c.snapshotLocked(), nil
	}
	pullMetadata := c.authority.metadata(plan.Revision(), captureplane.OperationPullCaptureTracks, stableIdempotencyKey(c.authority.CaptureEpoch, plan.Revision(), captureplane.OperationPullCaptureTracks, "initial"))
	pull, err := c.executePull(ctx, pullMetadata, c.connection.ConnectionReference, requested, nil)
	if err != nil {
		return Snapshot{}, err
	}
	if err := c.validatePulledTracks(pull, pullMetadata, requested); err != nil {
		return Snapshot{}, err
	}
	if err := c.peer.RegisterTracks(pull.Tracks); err != nil {
		return Snapshot{}, fmt.Errorf("register initial capture tracks: %w", err)
	}
	if err := c.settleNegotiation(ctx, plan.Revision(), c.connection.ConnectionReference, create.Negotiation, "create"); err != nil {
		return Snapshot{}, err
	}
	if err := c.settleNegotiation(ctx, plan.Revision(), c.connection.ConnectionReference, pull.Negotiation, "pull"); err != nil {
		return Snapshot{}, err
	}
	c.setActiveTracks(pull.Tracks)
	c.plan = plan
	c.bootstrapped = true
	return c.snapshotLocked(), nil
}

// Reconcile applies a newer immutable plan. Removed, replaced, and layer
// changed provider tracks are closed before additions are pulled.
func (c *Coordinator) Reconcile(ctx context.Context, plan captureplan.Plan) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return Snapshot{}, ErrCaptureClosed
	}
	if err := c.checkDeadlineLocked(); err != nil {
		return Snapshot{}, err
	}
	if err := c.authority.validatePlan(plan); err != nil {
		return Snapshot{}, err
	}
	if !c.bootstrapped {
		return Snapshot{}, ErrNotBootstrapped
	}
	return c.reconcileLocked(ctx, plan)
}

// WaitAndReconcile waits for the next server-issued plan revision and then
// reconciles it against the coordinator's active snapshot.
func (c *Coordinator) WaitAndReconcile(ctx context.Context, source PlanSource, maxWait time.Duration) (Snapshot, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return Snapshot{}, ErrCaptureClosed
	}
	if !c.bootstrapped {
		c.mu.Unlock()
		return Snapshot{}, ErrNotBootstrapped
	}
	remaining := c.authority.HardDeadline.Sub(c.now().UTC())
	if remaining < captureplan.MinimumWait {
		c.mu.Unlock()
		return Snapshot{}, ErrDeadlineExpired
	}
	if maxWait > remaining {
		maxWait = remaining
	}
	after := c.plan.Revision()
	input := c.authority.waitInput(after, maxWait)
	c.mu.Unlock()
	if source == nil {
		return Snapshot{}, fmt.Errorf("%w: plan source", ErrInvalidPlan)
	}
	next, err := source.WaitForPlan(ctx, input)
	if err != nil {
		return Snapshot{}, err
	}
	return c.Reconcile(ctx, next)
}

func (c *Coordinator) Snapshot() (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return Snapshot{}, ErrCaptureClosed
	}
	if !c.bootstrapped {
		return Snapshot{}, ErrNotBootstrapped
	}
	return c.snapshotLocked(), nil
}

// Close closes the provider capture connection for this exact server-issued
// epoch. A successful replay is idempotent; the coordinator never creates a
// replacement peer or advances the epoch.
func (c *Coordinator) Close(ctx context.Context, force bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	if !c.bootstrapped {
		return ErrNotBootstrapped
	}
	if err := c.checkDeadlineLocked(); err != nil {
		return err
	}
	metadata := c.authority.metadata(c.plan.Revision(), captureplane.OperationCloseCaptureConnection, stableIdempotencyKey(c.authority.CaptureEpoch, c.plan.Revision(), captureplane.OperationCloseCaptureConnection, "connection"))
	tracks := c.snapshotLocked().Tracks
	input := captureplane.CloseCaptureConnectionInput{Metadata: metadata, Connection: c.connection.ConnectionReference, Tracks: tracks, Force: force}
	execution, err := c.execute(ctx, captureplane.OperationCloseCaptureConnection, metadata.PlanRevision, metadata.IdempotencyKey, capturesignaling.CommandInput{CloseCaptureConnection: &input})
	if err != nil {
		return err
	}
	if execution.Result.CloseCaptureConnection == nil {
		return fmt.Errorf("%w: close connection result", ErrProtocol)
	}
	result := *execution.Result.CloseCaptureConnection
	if err := result.ValidateAgainst(metadata); err != nil {
		return fmt.Errorf("%w: close connection fence: %w", ErrProtocol, err)
	}
	if result.Connection.ConnectionReference != c.connection.ConnectionReference || !result.Closed {
		return fmt.Errorf("%w: close connection confirmation", ErrProtocol)
	}
	c.connection = result.Connection
	c.tracks = make(map[string]captureplane.PulledCaptureTrack)
	c.closed = true
	return nil
}

// RenewLease replaces the mutable worker lease after validating the renewal.
// It performs no background work; callers control when renewals happen.
func (c *Coordinator) RenewLease(lease capturesignaling.WorkerLease) error {
	return c.RenewLeaseAt(lease, c.now())
}

// RenewLeaseAt is the deterministic form used by tests and callers with a
// trusted clock.
func (c *Coordinator) RenewLeaseAt(lease capturesignaling.WorkerLease, now time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if lease.Owner != c.authority.Lease.Owner || lease.Token != c.authority.Lease.Token {
		return ErrLeaseRenewal
	}
	if err := lease.ValidateAt(now.UTC()); err != nil {
		return fmt.Errorf("%w: %w", ErrLeaseRenewal, err)
	}
	if lease.ExpiresAt.Before(c.authority.Lease.ExpiresAt) {
		return ErrLeaseRenewal
	}
	if lease.ExpiresAt.Equal(c.authority.Lease.ExpiresAt) {
		return nil
	}
	c.authority.Lease = capturesignaling.WorkerLease{Owner: lease.Owner, Token: lease.Token, ExpiresAt: lease.ExpiresAt.UTC()}
	return nil
}

// UpdateLease is an explicit alias for callers that model renewal as a state
// update rather than a heartbeat operation.
func (c *Coordinator) UpdateLease(lease capturesignaling.WorkerLease) error {
	return c.RenewLease(lease)
}

func (c *Coordinator) snapshotLocked() Snapshot {
	tracks := make([]captureplane.PulledCaptureTrack, 0, len(c.tracks))
	for _, track := range c.tracks {
		tracks = append(tracks, track)
	}
	sort.Slice(tracks, func(left, right int) bool {
		leftKey, rightKey := trackKey(tracks[left].CaptureTrack), trackKey(tracks[right].CaptureTrack)
		if leftKey != rightKey {
			return leftKey < rightKey
		}
		return tracks[left].MID < tracks[right].MID
	})
	return Snapshot{Connection: c.connection, PlanRevision: c.plan.Revision(), Tracks: tracks}
}

func (c *Coordinator) reconcileLocked(ctx context.Context, plan captureplan.Plan) (Snapshot, error) {
	if plan.Revision() < c.plan.Revision() {
		return Snapshot{}, ErrStalePlan
	}
	if plan.Revision() == c.plan.Revision() {
		if stringFingerprint(c.plan) != stringFingerprint(plan) {
			return Snapshot{}, ErrPlanConflict
		}
		return c.snapshotLocked(), nil
	}

	desired, err := tracksForPlan(plan)
	if err != nil {
		return Snapshot{}, err
	}
	removed, additions := diffTracks(c.tracks, desired)
	if len(removed) > 0 {
		metadata := c.authority.metadata(plan.Revision(), captureplane.OperationCloseCaptureTracks, stableIdempotencyKey(c.authority.CaptureEpoch, plan.Revision(), captureplane.OperationCloseCaptureTracks, "removed"))
		if err := c.executeCloseTracks(ctx, metadata, c.connection.ConnectionReference, removed); err != nil {
			return Snapshot{}, err
		}
		for _, track := range removed {
			delete(c.tracks, trackKey(track.CaptureTrack))
		}
	}
	if len(additions) > 0 {
		metadata := c.authority.metadata(plan.Revision(), captureplane.OperationPullCaptureTracks, stableIdempotencyKey(c.authority.CaptureEpoch, plan.Revision(), captureplane.OperationPullCaptureTracks, "additions"))
		pulled, err := c.executePull(ctx, metadata, c.connection.ConnectionReference, additions, nil)
		if err != nil {
			return Snapshot{}, err
		}
		if err := c.validatePulledTracks(pulled, metadata, additions); err != nil {
			return Snapshot{}, err
		}
		if err := c.peer.RegisterTracks(pulled.Tracks); err != nil {
			return Snapshot{}, fmt.Errorf("register capture track additions: %w", err)
		}
		if err := c.settleNegotiation(ctx, plan.Revision(), c.connection.ConnectionReference, pulled.Negotiation, "additions"); err != nil {
			return Snapshot{}, err
		}
		c.setActiveTracks(pulled.Tracks)
	}
	c.connection.PlanRevision = plan.Revision()
	c.plan = plan
	return c.snapshotLocked(), nil
}

func (c *Coordinator) executeCreate(ctx context.Context, metadata captureplane.OperationMetadata) (captureplane.CreateCaptureConnectionResult, error) {
	input := captureplane.CreateCaptureConnectionInput{Metadata: metadata}
	execution, err := c.execute(ctx, captureplane.OperationCreateCaptureConnection, metadata.PlanRevision, metadata.IdempotencyKey, capturesignaling.CommandInput{CreateCaptureConnection: &input})
	if err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	if execution.Result.CreateCaptureConnection == nil {
		return captureplane.CreateCaptureConnectionResult{}, fmt.Errorf("%w: create result", ErrProtocol)
	}
	return *execution.Result.CreateCaptureConnection, nil
}

func (c *Coordinator) executePull(ctx context.Context, metadata captureplane.OperationMetadata, connection captureplane.ProviderReference, tracks []captureplane.CaptureTrack, local *captureplane.Description) (captureplane.PullCaptureTracksResult, error) {
	input := captureplane.PullCaptureTracksInput{Metadata: metadata, Connection: connection, Tracks: append([]captureplane.CaptureTrack(nil), tracks...), LocalDescription: local}
	execution, err := c.execute(ctx, captureplane.OperationPullCaptureTracks, metadata.PlanRevision, metadata.IdempotencyKey, capturesignaling.CommandInput{PullCaptureTracks: &input})
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	if execution.Result.PullCaptureTracks == nil {
		return captureplane.PullCaptureTracksResult{}, fmt.Errorf("%w: pull result", ErrProtocol)
	}
	return *execution.Result.PullCaptureTracks, nil
}

func (c *Coordinator) executeCloseTracks(ctx context.Context, metadata captureplane.OperationMetadata, connection captureplane.ProviderReference, tracks []captureplane.PulledCaptureTrack) error {
	input := captureplane.CloseCaptureTracksInput{Metadata: metadata, Connection: connection, Tracks: append([]captureplane.PulledCaptureTrack(nil), tracks...)}
	execution, err := c.execute(ctx, captureplane.OperationCloseCaptureTracks, metadata.PlanRevision, metadata.IdempotencyKey, capturesignaling.CommandInput{CloseCaptureTracks: &input})
	if err != nil {
		return err
	}
	if execution.Result.CloseCaptureTracks == nil {
		return fmt.Errorf("%w: close tracks result", ErrProtocol)
	}
	result := *execution.Result.CloseCaptureTracks
	if err := result.ValidateAgainst(metadata); err != nil {
		return fmt.Errorf("%w: close tracks fence: %w", ErrProtocol, err)
	}
	if result.Connection.ConnectionReference != connection {
		return fmt.Errorf("%w: close tracks connection", ErrProtocol)
	}
	expected, err := captureplane.CanonicalizePulledCaptureTracks(tracks)
	if err != nil {
		return fmt.Errorf("%w: close tracks request: %w", ErrProtocol, err)
	}
	actual, err := captureplane.CanonicalizePulledCaptureTracks(result.Tracks)
	if err != nil {
		return fmt.Errorf("%w: close tracks result: %w", ErrProtocol, err)
	}
	if len(actual) != len(expected) {
		return fmt.Errorf("%w: close tracks count", ErrProtocol)
	}
	for index := range expected {
		if expected[index] != actual[index] {
			return fmt.Errorf("%w: close tracks identity", ErrProtocol)
		}
	}
	c.connection = result.Connection
	if err := c.settleNegotiation(ctx, metadata.PlanRevision, connection, result.Negotiation, "close"); err != nil {
		return err
	}
	return nil
}

func (c *Coordinator) execute(ctx context.Context, operation captureplane.OperationKind, revision captureplane.PlanRevision, key string, input capturesignaling.CommandInput) (capturesignaling.Execution, error) {
	if err := c.checkDeadlineLocked(); err != nil {
		return capturesignaling.Execution{}, err
	}
	command := capturesignaling.Command{
		SignalingHandle: c.authority.SignalingHandle,
		Authority:       c.authority.commandAuthority(),
		Lease:           c.authority.Lease,
		Identity:        capturesignaling.CommandIdentity{Operation: operation, PlanRevision: revision, IdempotencyKey: key},
		Input:           input,
	}
	execution, err := c.signaling.Execute(ctx, capturesignaling.ExecuteRequest{Command: command})
	if err != nil {
		return capturesignaling.Execution{}, err
	}
	expectedKey := capturesignaling.CommandKey{SignalingHandle: command.SignalingHandle, Operation: operation, PlanRevision: revision, IdempotencyKey: key}
	if execution.Key != expectedKey {
		return capturesignaling.Execution{}, fmt.Errorf("%w: command key mismatch", ErrProtocol)
	}
	return execution, nil
}

func (c *Coordinator) checkDeadlineLocked() error {
	if c.authority.HardDeadline.IsZero() || !c.now().UTC().Before(c.authority.HardDeadline) {
		return ErrDeadlineExpired
	}
	return nil
}

func (c *Coordinator) validatePulledTracks(result captureplane.PullCaptureTracksResult, metadata captureplane.OperationMetadata, requested []captureplane.CaptureTrack) error {
	if err := result.ValidateAgainst(metadata); err != nil {
		return fmt.Errorf("%w: pulled tracks: %w", ErrProtocol, err)
	}
	if result.Connection.ConnectionReference != c.connection.ConnectionReference {
		return fmt.Errorf("%w: pulled tracks connection", ErrProtocol)
	}
	if len(result.Tracks) != len(requested) {
		return fmt.Errorf("%w: pulled track count", ErrProtocol)
	}
	requestedByProvider := make(map[string]captureplane.CaptureTrack, len(requested))
	for _, track := range requested {
		requestedByProvider[providerKey(track.OwnerReference, track.TrackReference)] = track
	}
	for _, pulled := range result.Tracks {
		requestedTrack, ok := requestedByProvider[providerKey(pulled.OwnerReference, pulled.TrackReference)]
		if !ok || requestedTrack.ParticipantID != pulled.ParticipantID || requestedTrack.ParticipantGeneration != pulled.ParticipantGeneration || requestedTrack.Source != pulled.Source || requestedTrack.Kind != pulled.Kind || requestedTrack.RequestedLayer != pulled.RequestedLayer {
			return fmt.Errorf("%w: pulled track identity", ErrProtocol)
		}
	}
	c.connection = result.Connection
	return nil
}

func (c *Coordinator) settleNegotiation(ctx context.Context, revision captureplane.PlanRevision, connection captureplane.ProviderReference, negotiation captureplane.Negotiation, phase string) error {
	if err := negotiation.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
	}
	for exchanges := 0; ; {
		if err := c.checkDeadlineLocked(); err != nil {
			return err
		}
		switch negotiation.Requirement {
		case captureplane.NegotiationNotRequired:
			return nil
		case captureplane.NegotiationRemoteAnswer:
			if err := c.peer.ApplyRemoteAnswer(ctx, negotiation); err != nil {
				return fmt.Errorf("apply provider answer: %w", err)
			}
			return nil
		case captureplane.NegotiationAnswerNeeded:
			if exchanges >= c.maxRounds {
				return ErrNegotiationLoop
			}
			answer, err := c.peer.AnswerRemoteOffer(ctx, negotiation)
			if err != nil {
				return fmt.Errorf("answer provider offer: %w", err)
			}
			if err := answer.Validate(); err != nil || answer.Type != "answer" {
				return fmt.Errorf("%w: local answer", ErrInvalidNegotiation)
			}
			negotiation, err = c.renegotiate(ctx, revision, connection, negotiation.ID, answer, phase, exchanges)
			if err != nil {
				return err
			}
			exchanges++
		case captureplane.NegotiationOfferNeeded:
			if exchanges >= c.maxRounds {
				return ErrNegotiationLoop
			}
			local, err := c.peer.CreateLocalOffer(ctx, negotiation.ID)
			if err != nil {
				return fmt.Errorf("create local offer: %w", err)
			}
			if err := local.Validate(); err != nil || local.Requirement != captureplane.NegotiationOfferNeeded || local.ID != negotiation.ID || local.Description == nil || local.Description.Type != "offer" {
				return fmt.Errorf("%w: local offer provider fence", ErrInvalidNegotiation)
			}
			negotiation, err = c.renegotiate(ctx, revision, connection, negotiation.ID, *local.Description, phase, exchanges)
			if err != nil {
				return err
			}
			exchanges++
		default:
			return fmt.Errorf("%w: requirement %q", ErrInvalidNegotiation, negotiation.Requirement)
		}
		if err := negotiation.Validate(); err != nil {
			return fmt.Errorf("%w: provider response: %w", ErrInvalidNegotiation, err)
		}
	}
}

func (c *Coordinator) renegotiate(ctx context.Context, revision captureplane.PlanRevision, connection captureplane.ProviderReference, negotiationID captureplane.ProviderReference, description captureplane.Description, phase string, round int) (captureplane.Negotiation, error) {
	key := stableIdempotencyKey(c.authority.CaptureEpoch, revision, captureplane.OperationRenegotiateCaptureConnection, phase+":"+strconv.Itoa(round)+":"+negotiationID.String())
	metadata := c.authority.metadata(revision, captureplane.OperationRenegotiateCaptureConnection, key)
	input := captureplane.RenegotiateCaptureConnectionInput{Metadata: metadata, Connection: connection, NegotiationID: negotiationID, Description: description}
	execution, err := c.execute(ctx, captureplane.OperationRenegotiateCaptureConnection, revision, key, capturesignaling.CommandInput{RenegotiateCaptureConnection: &input})
	if err != nil {
		return captureplane.Negotiation{}, err
	}
	if execution.Result.RenegotiateCaptureConnection == nil {
		return captureplane.Negotiation{}, fmt.Errorf("%w: renegotiation result", ErrProtocol)
	}
	result := *execution.Result.RenegotiateCaptureConnection
	if err := result.ValidateAgainst(metadata); err != nil {
		return captureplane.Negotiation{}, fmt.Errorf("%w: renegotiation fence: %w", ErrProtocol, err)
	}
	if result.Connection.ConnectionReference != connection {
		return captureplane.Negotiation{}, fmt.Errorf("%w: renegotiation connection", ErrProtocol)
	}
	c.connection = result.Connection
	return result.Negotiation, nil
}

func tracksForPlan(plan captureplan.Plan) ([]captureplane.CaptureTrack, error) {
	tracks := make([]captureplane.CaptureTrack, 0, len(plan.Tracks()))
	for _, track := range plan.Tracks() {
		tracks = append(tracks, captureplane.CaptureTrack{
			OwnerReference: track.OwnerReference, TrackReference: track.TrackReference,
			ParticipantID: track.ParticipantID, ParticipantGeneration: track.ParticipantGeneration,
			Source: track.Source, Kind: track.Kind, RequestedLayer: track.RequestedLayer,
		})
	}
	if len(tracks) == 0 {
		return nil, nil
	}
	canonical, err := captureplane.CanonicalizeCaptureTracks(tracks)
	if err != nil {
		return nil, fmt.Errorf("%w: tracks: %w", ErrInvalidPlan, err)
	}
	return canonical, nil
}

func (c *Coordinator) setActiveTracks(tracks []captureplane.PulledCaptureTrack) {
	for _, track := range tracks {
		c.tracks[trackKey(track.CaptureTrack)] = track
	}
}

func diffTracks(active map[string]captureplane.PulledCaptureTrack, desired []captureplane.CaptureTrack) ([]captureplane.PulledCaptureTrack, []captureplane.CaptureTrack) {
	desiredByKey := make(map[string]captureplane.CaptureTrack, len(desired))
	for _, track := range desired {
		desiredByKey[trackKey(track)] = track
	}
	removed := make([]captureplane.PulledCaptureTrack, 0)
	for key, current := range active {
		desiredTrack, ok := desiredByKey[key]
		if !ok || !sameTrack(current.CaptureTrack, desiredTrack) {
			removed = append(removed, current)
		}
	}
	additions := make([]captureplane.CaptureTrack, 0)
	for key, desiredTrack := range desiredByKey {
		current, ok := active[key]
		if !ok || !sameTrack(current.CaptureTrack, desiredTrack) {
			additions = append(additions, desiredTrack)
		}
	}
	sort.Slice(removed, func(i, j int) bool { return trackKey(removed[i].CaptureTrack) < trackKey(removed[j].CaptureTrack) })
	sort.Slice(additions, func(i, j int) bool { return trackKey(additions[i]) < trackKey(additions[j]) })
	return removed, additions
}

func sameTrack(left captureplane.CaptureTrack, right captureplane.CaptureTrack) bool {
	return left.OwnerReference == right.OwnerReference && left.TrackReference == right.TrackReference && left.ParticipantID == right.ParticipantID && left.ParticipantGeneration == right.ParticipantGeneration && left.Source == right.Source && left.Kind == right.Kind && left.RequestedLayer == right.RequestedLayer
}

func trackKey(track captureplane.CaptureTrack) string {
	return fmt.Sprintf("%s\x00%d\x00%s\x00%s", track.ParticipantID, track.ParticipantGeneration, track.Source, track.Kind)
}

func providerKey(owner, track captureplane.ProviderReference) string {
	return owner.String() + "\x00" + track.String()
}

func stableIdempotencyKey(epoch captureplane.CaptureEpoch, revision captureplane.PlanRevision, operation captureplane.OperationKind, discriminator string) string {
	digest := sha256.Sum256([]byte(discriminator))
	key := fmt.Sprintf("capture/%d/%d/%s/%s", epoch, revision, operation, hex.EncodeToString(digest[:8]))
	if len(key) > captureplane.MaxIdempotencyKeyBytes {
		return key[:captureplane.MaxIdempotencyKeyBytes]
	}
	return key
}

func stringFingerprint(plan captureplan.Plan) string { return plan.FingerprintHex() }

func staleOrConflict(active, next captureplan.Plan) error {
	if active.Revision() > next.Revision() {
		return ErrStalePlan
	}
	if active.Revision() == next.Revision() && stringFingerprint(active) != stringFingerprint(next) {
		return ErrPlanConflict
	}
	return errors.New("capture plan did not advance")
}
