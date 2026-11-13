package recordercapture

import (
	"context"
	"fmt"
	"sort"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

// Snapshot is the coordinator's active provider-track view. The slices are
// copied before they leave the coordinator.
type Snapshot struct {
	Connection    captureplane.CaptureConnection
	PlanRevision  captureplane.PlanRevision
	Tracks        []captureplane.PulledCaptureTrack
	PendingTracks bool
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
	if c.connection.ConnectionReference.IsZero() {
		c.closed = true
		return nil
	}
	// The media deadline forbids new capture, not fenced provider cleanup.
	revision := max(c.plan.Revision(), c.cleanupRevision)
	metadata := c.authority.metadata(revision, captureplane.OperationCloseCaptureConnection, stableIdempotencyKey(c.authority.CaptureEpoch, revision, captureplane.OperationCloseCaptureConnection, "connection"))
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
	return Snapshot{Connection: c.connection, PlanRevision: c.plan.Revision(), Tracks: tracks, PendingTracks: c.retryUnavailable}
}
