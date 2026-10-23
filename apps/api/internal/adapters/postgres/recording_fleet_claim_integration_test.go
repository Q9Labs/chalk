package postgres_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingFleetClaimSerializesWithAdmissionClosure(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	workerID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(t.Context(), `insert into recording_fleet_nodes (
		environment, role, provider_id, node_name, region, release_id,
		image_digest, boot_generation, inventory_digest, worker_id,
		state, observed_at, ready, admission_open, ready_capacity
	) values ('claimrace-test', 'capture', $1, 'claimrace-test', 'sgp1', 'release-test',
		'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', $2,
		'active', clock_timestamp(), true, true, 1)`, workerID.String(), workerID.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(context.Background(), `delete from recording_fleet_nodes where worker_id = $1`, workerID.Bytes()); err != nil {
			t.Errorf("clean up fleet worker: %v", err)
		}
	}()
	closeInput := sqlc.CloseRecordingFleetNodeAdmissionParams{
		Environment: "claimrace-test", Role: "capture", ProviderID: workerID.String(),
		WorkerID: pgtype.UUID{Bytes: workerID.Bytes(), Valid: true}, BootGeneration: 1,
	}
	claimTx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = claimTx.Rollback(context.Background()) }()
	authorized, err := sqlc.New(claimTx).LockRecordingFleetWorkerClaim(t.Context(), sqlc.LockRecordingFleetWorkerClaimParams{Role: "capture", LeaseOwner: workerID.String()})
	if err != nil || !authorized {
		t.Fatalf("lock admitted worker: authorized=%t, error=%v", authorized, err)
	}
	closeTx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = closeTx.Rollback(context.Background()) }()
	if _, err := closeTx.Exec(t.Context(), `set local lock_timeout = '50ms'`); err != nil {
		t.Fatal(err)
	}
	_, err = sqlc.New(closeTx).CloseRecordingFleetNodeAdmission(t.Context(), closeInput)
	var locked *pgconn.PgError
	if !errors.As(err, &locked) || locked.Code != "55P03" {
		t.Fatalf("admission closure overtook an in-flight claim: %v", err)
	}
	if err := closeTx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := claimTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	closeTx, err = pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = closeTx.Rollback(context.Background()) }()
	if _, err := sqlc.New(closeTx).CloseRecordingFleetNodeAdmission(t.Context(), closeInput); err != nil {
		t.Fatal(err)
	}
	requestID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	input := recordingpipeline.ClaimInput{
		ClaimRequestID: requestID, Kind: recordingpipeline.JobKindCapture, Owner: workerID.String(),
		LeaseToken: "fixture-token", LeaseFor: time.Minute,
	}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if _, err := repository.Claim(ctx, input); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("claim did not wait for admission closure: %v", err)
	}
	if err := closeTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Claim(t.Context(), input); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("closed worker accepted a new claim: %v", err)
	}
}
