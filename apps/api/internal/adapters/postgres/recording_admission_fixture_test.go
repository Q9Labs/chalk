package postgres_test

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func cleanupRecordingAdmissionFixture(ctx context.Context, pool *pgxpool.Pool, tenantID utilities.ID) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, table := range []string{"recording_presentation_reactions", "recording_presentation_assets", "recording_presentations", "recording_presentation_sources", "recording_presentation_baselines", "recording_job_attempt_authorities"} {
		if _, err := tx.Exec(ctx, "alter table "+table+" disable trigger user"); err != nil {
			return err
		}
		predicate := "tenant_id = $1"
		if table == "recording_job_attempt_authorities" {
			predicate = "job_id in (select id from recording_jobs where tenant_id = $1)"
		}
		if _, err := tx.Exec(ctx, "delete from "+table+" where "+predicate, tenantID.Bytes()); err != nil {
			return fmt.Errorf("delete %s: %w", table, err)
		}
		if _, err := tx.Exec(ctx, "alter table "+table+" enable trigger user"); err != nil {
			return err
		}
	}
	for _, table := range []string{"recording_jobs", "recording_pipelines", "recording_reservations", "recordings", "episodes", "spaces"} {
		if _, err := tx.Exec(ctx, "delete from "+table+" where tenant_id = $1", tenantID.Bytes()); err != nil {
			return fmt.Errorf("delete %s: %w", table, err)
		}
	}
	if _, err := tx.Exec(ctx, "delete from tenants where id = $1", tenantID.Bytes()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "update recording_capacity set reserved_episodes = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0 where id = 1"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
