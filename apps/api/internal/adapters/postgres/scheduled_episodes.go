package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/scheduledepisodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type scheduledEpisodeDB interface {
	sqlc.DBTX
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type ScheduledEpisodeRepository struct {
	db      scheduledEpisodeDB
	queries *sqlc.Queries
}

func NewScheduledEpisodeRepository(db scheduledEpisodeDB) ScheduledEpisodeRepository {
	return ScheduledEpisodeRepository{db: db, queries: sqlc.New(db)}
}

// Put holds the Space in a shared lock while it writes, so an archive cannot slip in between the
// check and the write. The write itself takes the booking's row lock, which serializes writers of
// one booking: a cancel that commits first makes the later Put find the tombstone.
func (r ScheduledEpisodeRepository) Put(ctx context.Context, input scheduledepisodes.PutInput) (scheduledepisodes.ScheduledEpisode, error) {
	participants, err := json.Marshal(input.ExpectedParticipants)
	if err != nil {
		return scheduledepisodes.ScheduledEpisode{}, fmt.Errorf("encode expected participants: %w", err)
	}
	var saved sqlc.ScheduledEpisode
	err = r.inTx(ctx, func(queries *sqlc.Queries) error {
		space, err := queries.LockScheduledEpisodeSpace(ctx, sqlc.LockScheduledEpisodeSpaceParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return scheduledepisodes.ErrSpaceNotFound
		}
		if err != nil {
			return fmt.Errorf("lock Space of Scheduled Episode: %w", err)
		}
		if space.Valid {
			return scheduledepisodes.ErrSpaceArchived
		}
		saved, err = queries.PutScheduledEpisode(ctx, sqlc.PutScheduledEpisodeParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), ID: uuid(input.ID),
			StartsAt:             pgtype.Timestamptz{Time: input.StartsAt, Valid: true},
			ExpectedEndsAt:       pgtype.Timestamptz{Time: input.ExpectedEndsAt, Valid: true},
			ExpectedParticipants: participants,
			Metadata:             jsonBytes(input.Metadata),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			// The upsert only skips a booking that is cancelled.
			return scheduledepisodes.ErrCancelled
		}
		var invalidJSON *pgconn.PgError
		if errors.As(err, &invalidJSON) && (invalidJSON.Code == "22P05" || invalidJSON.Code == "22003") {
			// JSONB rejects embedded NUL and numbers outside its numeric range.
			return scheduledepisodes.ErrInvalidMetadata
		}
		if err != nil {
			return fmt.Errorf("put Scheduled Episode: %w", err)
		}
		return nil
	})
	if err != nil {
		return scheduledepisodes.ScheduledEpisode{}, err
	}
	return scheduledEpisodeFromRow(saved)
}

func (r ScheduledEpisodeRepository) Get(ctx context.Context, tenantID, spaceID, id utilities.ID) (scheduledepisodes.ScheduledEpisode, error) {
	row, err := r.queries.GetScheduledEpisode(ctx, sqlc.GetScheduledEpisodeParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), ID: uuid(id)})
	if errors.Is(err, pgx.ErrNoRows) {
		return scheduledepisodes.ScheduledEpisode{}, scheduledepisodes.ErrNotFound
	}
	if err != nil {
		return scheduledepisodes.ScheduledEpisode{}, fmt.Errorf("get Scheduled Episode: %w", err)
	}
	if !row.StartsAt.Valid {
		// A tombstone for an id that was never written holds no expectation to show.
		return scheduledepisodes.ScheduledEpisode{}, scheduledepisodes.ErrNotFound
	}
	return scheduledEpisodeFromRow(row)
}

func (r ScheduledEpisodeRepository) Cancel(ctx context.Context, tenantID, spaceID, id utilities.ID) error {
	return r.inTx(ctx, func(queries *sqlc.Queries) error {
		if _, err := queries.LockScheduledEpisodeSpace(ctx, sqlc.LockScheduledEpisodeSpaceParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)}); errors.Is(err, pgx.ErrNoRows) {
			return scheduledepisodes.ErrSpaceNotFound
		} else if err != nil {
			return fmt.Errorf("lock Space of Scheduled Episode: %w", err)
		}
		if err := queries.CancelScheduledEpisode(ctx, sqlc.CancelScheduledEpisodeParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), ID: uuid(id)}); err != nil {
			return fmt.Errorf("cancel Scheduled Episode: %w", err)
		}
		return nil
	})
}

func (r ScheduledEpisodeRepository) inTx(ctx context.Context, run func(*sqlc.Queries) error) (err error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin Scheduled Episode transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback(ctx)
		}
	}()
	if err = run(r.queries.WithTx(tx)); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Scheduled Episode transaction: %w", err)
	}
	return nil
}

func scheduledEpisodeFromRow(row sqlc.ScheduledEpisode) (scheduledepisodes.ScheduledEpisode, error) {
	var participants []scheduledepisodes.ExpectedParticipant
	if err := json.Unmarshal(row.ExpectedParticipants, &participants); err != nil {
		return scheduledepisodes.ScheduledEpisode{}, fmt.Errorf("decode expected participants: %w", err)
	}
	return scheduledepisodes.ScheduledEpisode{
		TenantID: utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:  utilities.IDFromBytes(row.SpaceID.Bytes),
		ID:       utilities.IDFromBytes(row.ID.Bytes),
		Expectation: scheduledepisodes.Expectation{
			StartsAt:             timestamp(row.StartsAt),
			ExpectedEndsAt:       timestamp(row.ExpectedEndsAt),
			ExpectedParticipants: participants,
			Metadata:             jsonRaw(row.Metadata),
		},
		CancelledAt: nullableTimestamp(row.CancelledAt),
		CreatedAt:   timestamp(row.CreatedAt),
		UpdatedAt:   timestamp(row.UpdatedAt),
	}, nil
}
