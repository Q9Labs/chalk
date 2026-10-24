package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestRenderFleetObservationCountsDatabaseLiveLeasesUnderClockSkew(t *testing.T) {
	for _, kind := range []string{"render", "transcription"} {
		t.Run(kind, func(t *testing.T) {
			transaction, fixture := newAllocationCleanupFixture(t, false, kind)
			defer func() { _ = transaction.Rollback(context.Background()) }()
			workerID, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			var databaseNow time.Time
			if err := transaction.QueryRow(t.Context(), `select clock_timestamp()`).Scan(&databaseNow); err != nil {
				t.Fatal(err)
			}
			now := databaseNow.Add(time.Minute)
			heartbeat := databaseNow.Add(-5 * time.Hour)
			execCleanupFixture(t, transaction, `
				update recording_jobs set lease_owner = $2, lease_expires_at = $3 where id = $1`,
				fixture.jobID.Bytes(), workerID.String(), databaseNow.Add(30*time.Second))
			execCleanupFixture(t, transaction, `
				insert into recording_fleet_nodes (
					environment, role, provider_id, node_name, region, release_id,
					image_digest, boot_generation, inventory_digest, worker_id,
					state, observed_at
				) values ('fleetdrain-test', 'render', $1, 'render-test', 'sgp1', 'release-test',
					'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', $2,
					'draining', $3)`, workerID.String(), workerID.Bytes(), heartbeat)
			var databaseLive bool
			if err := transaction.QueryRow(t.Context(), `select state = 'leased' and lease_expires_at > clock_timestamp() from recording_jobs where id = $1`, fixture.jobID.Bytes()).Scan(&databaseLive); err != nil {
				t.Fatal(err)
			}
			if !databaseLive {
				t.Fatal("fixture lease expired before the skew check")
			}
			repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(transaction))
			key := recorderfleet.PoolKey{Environment: "fleetdrain-test", Role: workeridentity.RoleRender}
			observations, err := repository.ObserveNodes(t.Context(), key, now)
			if err != nil || len(observations) != 1 || observations[0].ActiveLeases != 1 || !observations[0].ObservedAt.Equal(heartbeat) || !observations[0].LeasesObservedAt.Equal(now) {
				t.Fatalf("live %s lease with old heartbeat: observations=%+v, error=%v", kind, observations, err)
			}
			execCleanupFixture(t, transaction, `update recording_fleet_nodes set state = 'revoked', revoked_at = clock_timestamp() where provider_id = $1`, workerID.String())
			observations, err = repository.ObserveNodes(t.Context(), key, now)
			if err != nil || len(observations) != 1 || observations[0].ActiveLeases != 1 {
				t.Fatalf("revoked identity hid a live %s lease: observations=%+v, error=%v", kind, observations, err)
			}
			execCleanupFixture(t, transaction, `update recording_jobs set lease_expires_at = $2 where id = $1`, fixture.jobID.Bytes(), databaseNow)
			observations, err = repository.ObserveNodes(t.Context(), key, now)
			if err != nil || len(observations) != 1 || !observations[0].IdentityRevoked || observations[0].ActiveLeases != 0 || !observations[0].ObservedAt.Equal(heartbeat) || !observations[0].LeasesObservedAt.Equal(now) {
				t.Fatalf("expired %s lease: observations=%+v, error=%v", kind, observations, err)
			}
		})
	}
}
