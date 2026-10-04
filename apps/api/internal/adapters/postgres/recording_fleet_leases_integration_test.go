package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRenderFleetObservationCountsLiveJobLeases(t *testing.T) {
	for _, kind := range []string{"render", "transcription"} {
		t.Run(kind, func(t *testing.T) {
			transaction, fixture := newAllocationCleanupFixture(t, false, kind)
			defer func() { _ = transaction.Rollback(context.Background()) }()
			workerID, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			heartbeat := now.Add(-10 * time.Second)
			execCleanupFixture(t, transaction, `
				update recording_jobs set lease_owner = $2, lease_expires_at = $3 where id = $1`,
				fixture.jobID.Bytes(), workerID.String(), now.Add(time.Hour))
			execCleanupFixture(t, transaction, `
				insert into recording_fleet_nodes (
					environment, role, provider_id, node_name, region, release_id,
					image_digest, boot_generation, inventory_digest, worker_id,
					state, observed_at
				) values ('fleetdrain-test', 'render', $1, 'render-test', 'sgp1', 'release-test',
					'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', $2,
					'draining', $3)`, workerID.String(), workerID.Bytes(), heartbeat)
			queries := sqlc.New(transaction)
			input := sqlc.ListRecordingFleetNodeObservationsParams{
				Environment: "fleetdrain-test", Role: "render", ObservedAt: pgtype.Timestamptz{Time: now, Valid: true},
			}
			observations, err := queries.ListRecordingFleetNodeObservations(t.Context(), input)
			if err != nil || len(observations) != 1 || observations[0].ActiveLeases != 1 || !observations[0].ObservedAt.Time.Equal(heartbeat) {
				t.Fatalf("live %s lease with old heartbeat: observations=%+v, error=%v", kind, observations, err)
			}
			execCleanupFixture(t, transaction, `update recording_jobs set lease_expires_at = $2 where id = $1`, fixture.jobID.Bytes(), now)
			observations, err = queries.ListRecordingFleetNodeObservations(t.Context(), input)
			if err != nil || len(observations) != 1 || observations[0].ActiveLeases != 0 {
				t.Fatalf("expired %s lease: observations=%+v, error=%v", kind, observations, err)
			}
		})
	}
}
