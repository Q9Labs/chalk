package recordercapture

import (
	"context"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

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

func (c *Coordinator) reconcileLocked(ctx context.Context, plan captureplan.Plan) (Snapshot, error) {
	if plan.Revision() < c.plan.Revision() {
		return Snapshot{}, ErrStalePlan
	}
	if plan.Revision() == c.plan.Revision() {
		if stringFingerprint(c.plan) != stringFingerprint(plan) {
			return Snapshot{}, ErrPlanConflict
		}
		if !c.retryUnavailable {
			return c.snapshotLocked(), nil
		}
	}

	desired, err := tracksForPlan(plan)
	if err != nil {
		return Snapshot{}, err
	}
	removed, additions := diffTracks(c.tracks, desired)
	if len(removed) > 0 {
		remaining := tracksWithout(c.tracks, removed)
		if err := c.peer.RegisterTracks(remaining); err != nil {
			return Snapshot{}, fmt.Errorf("register capture tracks after removals: %w", err)
		}
		metadata := c.authority.metadata(plan.Revision(), captureplane.OperationCloseCaptureTracks, stableIdempotencyKey(c.authority.CaptureEpoch, plan.Revision(), captureplane.OperationCloseCaptureTracks, "removed"))
		if err := c.executeCloseTracks(ctx, metadata, c.connection.ConnectionReference, removed); err != nil {
			return Snapshot{}, err
		}
		for _, track := range removed {
			delete(c.tracks, trackKey(track.CaptureTrack))
		}
	}
	var createNegotiation *captureplane.Negotiation
	if len(additions) > 0 && c.connection.ConnectionReference.IsZero() {
		negotiation, err := c.createConnection(ctx, plan)
		if err != nil {
			return Snapshot{}, err
		}
		createNegotiation = &negotiation
	}
	if len(additions) > 0 {
		metadata := c.authority.metadata(plan.Revision(), captureplane.OperationPullCaptureTracks, stableIdempotencyKey(c.authority.CaptureEpoch, plan.Revision(), captureplane.OperationPullCaptureTracks, fmt.Sprintf("additions-%d", c.pullAttempt)))
		pulled, err := c.executePull(ctx, metadata, c.connection.ConnectionReference, additions, nil)
		if err != nil {
			return Snapshot{}, err
		}
		if err := c.validatePulledTracks(pulled, metadata, additions); err != nil {
			return Snapshot{}, err
		}
		active := c.snapshotLocked().Tracks
		active = append(active, pulled.Tracks...)
		if err := c.peer.RegisterTracks(active); err != nil {
			return Snapshot{}, fmt.Errorf("register complete capture track set: %w", err)
		}
		if createNegotiation != nil {
			if err := c.settleNegotiation(ctx, plan.Revision(), c.connection.ConnectionReference, *createNegotiation, "create"); err != nil {
				return Snapshot{}, err
			}
		}
		if err := c.settleNegotiation(ctx, plan.Revision(), c.connection.ConnectionReference, pulled.Negotiation, "additions"); err != nil {
			return Snapshot{}, err
		}
		c.setActiveTracks(pulled.Tracks)
		c.retryUnavailable = len(pulled.Unavailable) > 0
		c.pullAttempt++
	} else {
		c.retryUnavailable = false
	}
	c.connection.PlanRevision = plan.Revision()
	c.plan = plan
	return c.snapshotLocked(), nil
}

func (c *Coordinator) createConnection(ctx context.Context, plan captureplan.Plan) (captureplane.Negotiation, error) {
	metadata := c.authority.metadata(plan.Revision(), captureplane.OperationCreateCaptureConnection, stableIdempotencyKey(c.authority.CaptureEpoch, plan.Revision(), captureplane.OperationCreateCaptureConnection, "connection"))
	create, err := c.executeCreate(ctx, metadata)
	if err != nil {
		return captureplane.Negotiation{}, err
	}
	if err := create.Connection.ValidateAgainst(metadata, captureplane.OperationCreateCaptureConnection); err != nil {
		return captureplane.Negotiation{}, fmt.Errorf("%w: create connection fence: %w", ErrProtocol, err)
	}
	c.connection = create.Connection
	return create.Negotiation, nil
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
	if operation != captureplane.OperationCloseCaptureConnection {
		if err := c.checkDeadlineLocked(); err != nil {
			return capturesignaling.Execution{}, err
		}
	}
	command := capturesignaling.Command{
		SignalingHandle: c.authority.SignalingHandle,
		Authority:       c.authority.commandAuthority(),
		Lease:           c.authority.Lease,
		Identity:        capturesignaling.CommandIdentity{Operation: operation, PlanRevision: revision, IdempotencyKey: key},
		Input:           input,
	}
	// A newer command can advance the durable connection even if its reply is
	// lost or reconciliation later fails. Retirement must cover that revision.
	c.cleanupRevision = max(c.cleanupRevision, revision)
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
