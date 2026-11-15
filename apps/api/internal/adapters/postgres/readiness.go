package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Readiness struct {
	Pool              *pgxpool.Pool
	RequiredMigration int64
}

func (r Readiness) Check(ctx context.Context) error {
	if r.Pool == nil {
		return fmt.Errorf("postgres pool is not configured")
	}

	if err := r.Pool.Ping(ctx); err != nil {
		return fmt.Errorf("ping postgres: %w", err)
	}
	if r.RequiredMigration <= 0 {
		return nil
	}

	var currentMigration int64
	if err := r.Pool.QueryRow(ctx, `
		select coalesce(max(version_id), 0)
		from goose_db_version
		where is_applied
	`).Scan(&currentMigration); err != nil {
		return fmt.Errorf("read postgres migration version: %w", err)
	}
	if err := validateMigrationVersion(currentMigration, r.RequiredMigration); err != nil {
		return err
	}

	return nil
}

const liveParticipantsQuery = `select count(*) from participant_presence_leases where expires_at > now()`

// LiveParticipants counts the participants whose presence lease has not expired. Sync renews a lease
// every few seconds for a connected participant and lets it lapse 120 seconds after the last renewal.
func (r Readiness) LiveParticipants(ctx context.Context) (int64, error) {
	var count int64
	if err := r.Pool.QueryRow(ctx, liveParticipantsQuery).Scan(&count); err != nil {
		return 0, fmt.Errorf("count live participants: %w", err)
	}
	return count, nil
}

func validateMigrationVersion(current, required int64) error {
	if current < required {
		return fmt.Errorf("postgres migration version %d is below required %d", current, required)
	}
	return nil
}
