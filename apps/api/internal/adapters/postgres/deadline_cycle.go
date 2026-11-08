package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	deadlinePhase       = "deadline"
	presenceExpiryPhase = "presence_expiry"
	emptyLingerPhase    = "empty_linger"
)

// maxAttemptedPerPhase keeps a pass inside its transaction timeout when many
// Episodes fail: a phase stops paging after this many attempts.
const maxAttemptedPerPhase = 500

// claimInPages claims Episodes one page at a time and keeps every Episode it
// already handled out of the next claim. Claims return the oldest Episodes
// first, so Episodes that fail and stay eligible would otherwise fill every
// page and starve the healthy ones behind them. Paging stops when the budget is
// spent, the candidates run out or the phase hit maxAttemptedPerPhase.
func claimInPages[Row any](
	budget func() int32,
	claim func(excluded []pgtype.UUID, limit int32) ([]Row, error),
	episodeOf func(Row) pgtype.UUID,
	handle func(Row) error,
) error {
	handled := []pgtype.UUID{}
	for len(handled) < maxAttemptedPerPhase {
		limit := budget()
		if limit <= 0 {
			return nil
		}
		rows, err := claim(handled, limit)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		for _, row := range rows {
			handled = append(handled, episodeOf(row))
			if err := handle(row); err != nil {
				return err
			}
		}
	}
	return nil
}

// deadlineCycle runs each Episode's scheduler work in its own savepoint. A
// failure rolls back only that Episode's writes and lists it as skipped, so one
// Episode that cannot take its fences does not undo the other Episodes' claimed
// work in the same transaction or stop later passes.
type deadlineCycle struct {
	result episodes.DeadlineCycle
	// fenced holds Episodes whose participants the presence phase fenced in this
	// transaction. The linger phase leaves them for the next pass: ending them
	// now would try to take fences that this transaction already holds.
	fenced map[utilities.ID]struct{}
}

func newDeadlineCycle() *deadlineCycle {
	return &deadlineCycle{fenced: map[utilities.ID]struct{}{}}
}

func (c *deadlineCycle) fencedByPresence(episodeID utilities.ID) bool {
	_, fenced := c.fenced[episodeID]
	return fenced
}

// step reports whether work completed. A non-nil error is not about the
// Episode: the context ended or the savepoint could not be rolled back, so the
// transaction is unusable and the pass must fail.
func (c *deadlineCycle) step(ctx context.Context, tx pgx.Tx, phase string, tenantID, episodeID utilities.ID, work func(*sqlc.Queries, pgx.Tx) error) (bool, error) {
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin %s savepoint: %w", phase, err)
	}
	workErr := work(sqlc.New(savepoint), savepoint)
	if workErr == nil {
		if err := savepoint.Commit(ctx); err != nil {
			return false, fmt.Errorf("release %s savepoint: %w", phase, err)
		}
		c.result.Completed = append(c.result.Completed, episodes.EpisodeRef{TenantID: tenantID, EpisodeID: episodeID})
		return true, nil
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if err := savepoint.Rollback(ctx); err != nil {
		return false, fmt.Errorf("roll back %s savepoint after %v: %w", phase, workErr, err)
	}
	c.result.Skipped = append(c.result.Skipped, episodes.SkippedEpisode{TenantID: tenantID, EpisodeID: episodeID, Phase: phase, Err: workErr})
	return false, nil
}
