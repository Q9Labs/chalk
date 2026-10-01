package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingPreparationQuerier interface {
	GetRecordingPreparation(context.Context, sqlc.GetRecordingPreparationParams) (sqlc.GetRecordingPreparationRow, error)
}

type RecordingPreparationRepository struct {
	pool    *pgxpool.Pool
	queries recordingPreparationQuerier
}

func NewRecordingPreparationRepository(pool *pgxpool.Pool) RecordingPreparationRepository {
	return RecordingPreparationRepository{pool: pool, queries: sqlc.New(pool)}
}

func (r RecordingPreparationRepository) Prepare(ctx context.Context, input recordingpreparation.Input, now time.Time) (recordingpreparation.Preparation, error) {
	return r.mutate(ctx, input, now, func(queries *sqlc.Queries) error {
		_, err := queries.PrepareRecordingSpace(ctx, sqlc.PrepareRecordingSpaceParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), StartsAt: timestamptzValue(input.StartsAt),
			ExpectedRevision: input.ExpectedRevision, ObservedAt: timestamptzValue(now),
		})
		return err
	})
}

func (r RecordingPreparationRepository) Cancel(ctx context.Context, input recordingpreparation.Input, now time.Time) (recordingpreparation.Preparation, error) {
	return r.mutate(ctx, input, now, func(queries *sqlc.Queries) error {
		_, err := queries.CancelRecordingPreparation(ctx, sqlc.CancelRecordingPreparationParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), ExpectedRevision: input.ExpectedRevision, ObservedAt: timestamptzValue(now),
		})
		return err
	})
}

func (r RecordingPreparationRepository) Get(ctx context.Context, tenantID, spaceID utilities.ID, now time.Time) (recordingpreparation.Preparation, error) {
	return getRecordingPreparation(ctx, r.queries, tenantID, spaceID, now)
}

func (r RecordingPreparationRepository) mutate(ctx context.Context, input recordingpreparation.Input, now time.Time, change func(*sqlc.Queries) error) (recordingpreparation.Preparation, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return recordingpreparation.Preparation{}, fmt.Errorf("begin recording preparation: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	// Share admission's lock so reschedule/cancel cannot race consumption or
	// allocate a second warm slot when an actual recording materializes.
	if _, err := queries.LockRecordingCapacity(ctx); err != nil {
		return recordingpreparation.Preparation{}, fmt.Errorf("lock recording preparation capacity: %w", err)
	}
	if err := change(queries); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingpreparation.Preparation{}, recordingpreparation.ErrConflict
		}
		return recordingpreparation.Preparation{}, fmt.Errorf("update recording preparation: %w", err)
	}
	preparation, err := getRecordingPreparation(ctx, queries, input.TenantID, input.SpaceID, now)
	if err != nil {
		return recordingpreparation.Preparation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return recordingpreparation.Preparation{}, fmt.Errorf("commit recording preparation: %w", err)
	}
	return preparation, nil
}

func getRecordingPreparation(ctx context.Context, queries recordingPreparationQuerier, tenantID, spaceID utilities.ID, now time.Time) (recordingpreparation.Preparation, error) {
	row, err := queries.GetRecordingPreparation(ctx, sqlc.GetRecordingPreparationParams{
		TenantID: uuid(tenantID), SpaceID: uuid(spaceID), ObservedAt: timestamptzValue(now),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpreparation.Preparation{}, recordingpreparation.ErrNotFound
	}
	if err != nil {
		return recordingpreparation.Preparation{}, fmt.Errorf("get recording preparation: %w", err)
	}
	return recordingpreparation.Preparation{
		TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes),
		StartsAt: row.StartsAt.Time, State: recordingpreparation.State(row.State), Revision: row.Revision,
		CapacityAvailable: row.CapacityAvailable, Ready: row.Ready, UpdatedAt: row.UpdatedAt.Time,
	}, nil
}

// PrepareEntrance shares the admission lock and revision protocol with scheduled
// preparations. An open Entrance cannot extend an existing preparation deadline.
func (r RecordingPreparationRepository) PrepareEntrance(ctx context.Context, tenantID, spaceID utilities.ID, now time.Time) (bool, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return false, fmt.Errorf("begin Entrance preparation: %w", err)
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	if _, err = q.LockRecordingCapacity(ctx); err != nil {
		return false, fmt.Errorf("lock Entrance preparation: %w", err)
	}
	row, err := q.GetRecordingEntranceEligibility(ctx, sqlc.GetRecordingEntranceEligibilityParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return false, fmt.Errorf("read Entrance eligibility: %w", err)
	}
	if row.RecordingPolicy != "automatic" || row.ArchivedAt.Valid || row.Active || (row.PreparationState == "scheduled" && row.StartsAt.Valid && !row.StartsAt.Time.After(now) && now.Before(row.StartsAt.Time.Add(recordingpreparation.NoShowGrace))) {
		return false, nil
	}
	_, err = q.PrepareRecordingSpace(ctx, sqlc.PrepareRecordingSpaceParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), StartsAt: timestamptzValue(now), ObservedAt: timestamptzValue(now), ExpectedRevision: row.Revision})
	if err != nil {
		return false, fmt.Errorf("prepare Entrance: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit Entrance preparation: %w", err)
	}
	slog.InfoContext(ctx, "Capture pre-warmed for Entrance", "event", "recording.entrance.prewarmed", "revision", row.Revision+1)
	return true, nil
}
