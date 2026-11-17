package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// KillSwitch is the stored Chalk SFU kill switch. A flip and its audit row commit together: a trigger writes the row.
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

// SetNewEpisodesPaused flips the switch and returns the value before the flip. The audit row
// is written by a trigger, with the origin that ctx carries. The command refuses a flip
// without one. Setting the value it already has still writes a row, so a repeated command
// leaves a trace.
func (k KillSwitch) SetNewEpisodesPaused(ctx context.Context, paused bool) (before bool, err error) {
	if _, err := mediaplane.RequireChangeOrigin(ctx); err != nil {
		return false, fmt.Errorf("flip the new-Episode kill switch: %w", err)
	}
	tx, err := k.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("flip the new-Episode kill switch: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tagPlaneChange(ctx, tx); err != nil {
		return false, err
	}
	queries := sqlc.New(tx)
	if before, err = queries.LockMediaPlaneKillSwitchForUpdate(ctx); err != nil {
		return false, fmt.Errorf("lock the new-Episode kill switch: %w", err)
	}
	if err := queries.SetMediaPlaneKillSwitch(ctx, paused); err != nil {
		return false, fmt.Errorf("write the new-Episode kill switch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit the new-Episode kill switch: %w", err)
	}
	return before, nil
}
