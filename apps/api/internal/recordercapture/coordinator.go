package recordercapture

import (
	"context"
	"fmt"
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

// Coordinator owns one provider connection and serializes all SDP exchanges for
// its immutable recorder attempt authority.
type Coordinator struct {
	mu sync.Mutex

	authority        AttemptAuthority
	signaling        SignalingPort
	peer             PeerPort
	maxRounds        int
	now              func() time.Time
	bootstrapped     bool
	closed           bool
	connection       captureplane.CaptureConnection
	plan             captureplan.Plan
	cleanupRevision  captureplane.PlanRevision
	tracks           map[string]captureplane.PulledCaptureTrack
	retryUnavailable bool
	pullAttempt      uint64
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

// Bootstrap registers the initial track set and, when nonempty, creates the
// provider connection, pulls its tracks, and settles negotiation.
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

	requested, err := tracksForPlan(plan)
	if err != nil {
		return Snapshot{}, err
	}
	if len(requested) == 0 {
		if err := c.peer.RegisterTracks(nil); err != nil {
			return Snapshot{}, fmt.Errorf("register empty initial capture track set: %w", err)
		}
		// Do not leave a provider connection idle while waiting for
		// the first publisher. Cloudflare can expire it before tracks/new.
		c.plan = plan
		c.bootstrapped = true
		return c.snapshotLocked(), nil
	}
	c.plan = plan
	createNegotiation, err := c.createConnection(ctx, plan)
	if err != nil {
		return Snapshot{}, err
	}
	pullMetadata := c.authority.metadata(plan.Revision(), captureplane.OperationPullCaptureTracks, stableIdempotencyKey(c.authority.CaptureEpoch, plan.Revision(), captureplane.OperationPullCaptureTracks, "initial"))
	pull, err := c.executePull(ctx, pullMetadata, c.connection.ConnectionReference, requested, nil)
	if err != nil {
		return Snapshot{}, err
	}
	if err := c.validatePulledTracks(pull, pullMetadata, requested); err != nil {
		return Snapshot{}, err
	}
	c.setActiveTracks(pull.Tracks)
	if err := c.peer.RegisterTracks(pull.Tracks); err != nil {
		return Snapshot{}, fmt.Errorf("register initial capture tracks: %w", err)
	}
	if err := c.settleNegotiation(ctx, plan.Revision(), c.connection.ConnectionReference, createNegotiation, "create"); err != nil {
		return Snapshot{}, err
	}
	if err := c.settleNegotiation(ctx, plan.Revision(), c.connection.ConnectionReference, pull.Negotiation, "pull"); err != nil {
		return Snapshot{}, err
	}
	c.setActiveTracks(pull.Tracks)
	c.retryUnavailable = len(pull.Unavailable) > 0
	c.pullAttempt++
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
