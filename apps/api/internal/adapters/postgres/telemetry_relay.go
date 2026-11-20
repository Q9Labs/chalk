package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

// RelayEvidence claims a bounded group for one export. The row locks keep API
// replicas from sending the same group concurrently. A crash before deletion
// leaves the original payload (and its event IDs) available to the next relay.
func (l TelemetryLedger) RelayEvidence(ctx context.Context, export func(context.Context, []json.RawMessage) error) (int, error) {
	tx, err := l.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin telemetry relay: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := sqlc.New(tx)
	// Take the write lock before claiming rows. A Tenant purge cannot take its
	// table fence in between and then block the deletion of a row it needs.
	if err := queries.LockTelemetryOutbox(ctx); err != nil {
		return 0, fmt.Errorf("lock the telemetry relay outbox: %w", err)
	}
	batches, err := queries.LockReadyTelemetryOutbox(ctx)
	if err != nil {
		return 0, fmt.Errorf("claim telemetry relay batches: %w", err)
	}
	if len(batches) == 0 {
		return 0, nil
	}
	ids := make([]int64, 0, len(batches))
	var rows []json.RawMessage
	for _, batch := range batches {
		var payload []json.RawMessage
		if err := json.Unmarshal(batch.Payload, &payload); err != nil {
			return 0, errors.New("decode stored telemetry relay payload")
		}
		rows = append(rows, payload...)
		ids = append(ids, batch.ID)
	}
	if err := export(ctx, rows); err != nil {
		// Retry refused batches separately: one bad payload must not hold up its neighbours.
		delayErr := queries.DelayTelemetryOutbox(ctx, ids)
		if delayErr == nil {
			delayErr = tx.Commit(ctx)
		}
		return 0, errors.Join(err, delayErr)
	}
	if err := queries.DeleteShippedTelemetryOutbox(ctx, ids); err != nil {
		return 0, fmt.Errorf("delete shipped telemetry relay batches: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit telemetry relay: %w", err)
	}
	return len(rows), nil
}
