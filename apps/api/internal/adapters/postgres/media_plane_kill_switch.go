package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

// KillSwitch is the stored own-SFU kill switch. A flip and its audit row commit together.
type KillSwitch struct {
	pool *pgxpool.Pool
}

func NewKillSwitch(pool *pgxpool.Pool) KillSwitch {
	return KillSwitch{pool: pool}
}

// NewEpisodesPaused reads the switch on its own connection, for callers outside a transaction.
// Episode creation reads it inside its transaction instead (see resolveEpisodeMediaBinding).
func (k KillSwitch) NewEpisodesPaused(ctx context.Context) (bool, error) {
	paused, err := sqlc.New(k.pool).ReadMediaPlaneKillSwitch(ctx)
	if err != nil {
		return false, fmt.Errorf("read the new-Episode kill switch: %w", err)
	}
	return paused, nil
}

// SetNewEpisodesPaused flips the switch and records who did it and why. It returns the value
// before the flip. Setting the value it already has still writes an audit row, so a repeated
// command leaves a trace.
func (k KillSwitch) SetNewEpisodesPaused(ctx context.Context, paused bool, operator, reason string) (before bool, err error) {
	operator, reason = strings.TrimSpace(operator), strings.TrimSpace(reason)
	if operator == "" || reason == "" {
		return false, errors.New("the kill switch needs an operator and a reason")
	}
	tx, err := k.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("flip the new-Episode kill switch: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := sqlc.New(tx)
	if before, err = queries.LockMediaPlaneKillSwitchForUpdate(ctx); err != nil {
		return false, fmt.Errorf("lock the new-Episode kill switch: %w", err)
	}
	if err := queries.SetMediaPlaneKillSwitch(ctx, paused); err != nil {
		return false, fmt.Errorf("write the new-Episode kill switch: %w", err)
	}
	if err := queries.RecordMediaPlaneKillSwitchChange(ctx, sqlc.RecordMediaPlaneKillSwitchChangeParams{
		PausedBefore: before, PausedAfter: paused, Operator: operator, Reason: reason,
	}); err != nil {
		return false, fmt.Errorf("audit the new-Episode kill switch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit the new-Episode kill switch: %w", err)
	}
	return before, nil
}
