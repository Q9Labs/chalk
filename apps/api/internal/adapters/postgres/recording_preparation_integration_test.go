package postgres_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestRecordingPreparationDurableLifecycle(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		url = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	tenantID := mustID(t, "bc390000-0000-4000-8000-000000000001")
	spaceID := mustID(t, "bc390000-0000-4000-8000-000000000002")
	episodeID := mustID(t, "bc390000-0000-4000-8000-000000000003")
	if _, err := tx.Exec(ctx, `insert into tenants (id, name) values ($1, 'preparation proof')`, tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into spaces (id, tenant_id, name, slug, media_plane, recording_policy) values ($1, $2, 'preparation proof', 'preparation-proof', 'cf_sfu', 'manual')`, spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `update recording_capacity set reserved_episodes = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0 where id = 1`); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	start := now.Add(time.Hour)
	input := sqlc.PrepareRecordingSpaceParams{
		TenantID: pgtype.UUID{Bytes: tenantID.Bytes(), Valid: true}, SpaceID: pgtype.UUID{Bytes: spaceID.Bytes(), Valid: true},
		StartsAt: pgtype.Timestamptz{Time: start, Valid: true}, ObservedAt: pgtype.Timestamptz{Time: now, Valid: true},
	}
	prepared, err := queries.PrepareRecordingSpace(ctx, input)
	if err != nil || prepared.State != "scheduled" || prepared.Revision != 1 {
		t.Fatalf("prepare = %+v, %v", prepared, err)
	}
	replay, err := queries.PrepareRecordingSpace(ctx, input)
	if err != nil || replay.Revision != prepared.Revision {
		t.Fatalf("replay = %+v, %v", replay, err)
	}
	var episodes, recordings int
	if err := tx.QueryRow(ctx, `select (select count(*) from episodes where space_id = $1), (select count(*) from recordings where space_id = $1)`, spaceID.Bytes()).Scan(&episodes, &recordings); err != nil {
		t.Fatal(err)
	}
	if episodes != 0 || recordings != 0 {
		t.Fatalf("preparation created %d Episodes and %d Recordings", episodes, recordings)
	}
	assertPreparationDemand(t, queries, now, 0)
	assertPreparationDemand(t, queries, start.Add(-5*time.Minute), 1)
	if _, err := tx.Exec(ctx, `insert into recording_pool_health (role, admission_open, ready_capacity, reason, observed_at, demand_revision)
		values ('capture', true, 3, 'ready', $1, 'preparation-test')
		on conflict (role) do update set admission_open = true, ready_capacity = 3, reason = 'ready', observed_at = excluded.observed_at`, start.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `update recording_capacity set reserved_episodes = 3 where id = 1`); err != nil {
		t.Fatal(err)
	}
	readinessInput := sqlc.GetRecordingPreparationParams{TenantID: input.TenantID, SpaceID: input.SpaceID, ObservedAt: pgtype.Timestamptz{Time: start.Add(-time.Minute), Valid: true}}
	busy, err := queries.GetRecordingPreparation(ctx, readinessInput)
	if err != nil || busy.Ready || !busy.CapacityAvailable {
		t.Fatalf("busy pool preparation readiness = %+v, %v", busy, err)
	}
	if _, err := tx.Exec(ctx, `update recording_capacity set reserved_episodes = 2 where id = 1`); err != nil {
		t.Fatal(err)
	}
	available, err := queries.GetRecordingPreparation(ctx, readinessInput)
	if err != nil || !available.Ready {
		t.Fatalf("idle slot preparation readiness = %+v, %v", available, err)
	}
	if _, err := tx.Exec(ctx, `update recording_capacity set reserved_episodes = 0 where id = 1`); err != nil {
		t.Fatal(err)
	}
	foreign := input
	foreign.TenantID = pgtype.UUID{Bytes: mustID(t, "bc390000-0000-4000-8000-000000000099").Bytes(), Valid: true}
	if _, err := queries.PrepareRecordingSpace(ctx, foreign); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-Tenant preparation = %v", err)
	}
	cancelInput := sqlc.CancelRecordingPreparationParams{TenantID: input.TenantID, SpaceID: input.SpaceID, ExpectedRevision: prepared.Revision, ObservedAt: input.ObservedAt}
	canceled, err := queries.CancelRecordingPreparation(ctx, cancelInput)
	if err != nil || canceled.State != "canceled" {
		t.Fatalf("cancel = %+v, %v", canceled, err)
	}
	if replay, err := queries.CancelRecordingPreparation(ctx, cancelInput); err != nil || replay.Revision != canceled.Revision {
		t.Fatalf("cancel replay = %+v, %v", replay, err)
	}
	assertPreparationDemand(t, queries, start.Add(-5*time.Minute), 0)
	if _, err := queries.PrepareRecordingSpace(ctx, input); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("stale reschedule = %v", err)
	}
	input.ExpectedRevision = canceled.Revision
	prepared, err = queries.PrepareRecordingSpace(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queries.ExpireRecordingReservations(ctx, pgtype.Timestamptz{Time: start.Add(5 * time.Minute), Valid: true}); err != nil {
		t.Fatal(err)
	}
	assertPreparationDemand(t, queries, start.Add(5*time.Minute), 0)
	status, err := queries.GetRecordingPreparation(ctx, sqlc.GetRecordingPreparationParams{TenantID: input.TenantID, SpaceID: input.SpaceID, ObservedAt: pgtype.Timestamptz{Time: start.Add(5 * time.Minute), Valid: true}})
	if err != nil || status.State != "expired" {
		t.Fatalf("no-show status = %+v, %v", status, err)
	}
	input.ExpectedRevision = status.Revision
	input.StartsAt = pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true}
	prepared, err = queries.PrepareRecordingSpace(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	assertPreparationDemand(t, queries, now, 1)
	if _, err := tx.Exec(ctx, `insert into episodes (id, tenant_id, space_id, status, config_snapshot) values ($1, $2, $3, 'active', '{}'::jsonb)`, episodeID.Bytes(), tenantID.Bytes(), spaceID.Bytes()); err != nil {
		t.Fatal(err)
	}
	_, err = queries.CreateRecordingReservation(ctx, sqlc.CreateRecordingReservationParams{
		TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: pgtype.UUID{Bytes: episodeID.Bytes(), Valid: true},
		ID:             pgtype.UUID{Bytes: mustID(t, "bc390000-0000-4000-8000-000000000004").Bytes(), Valid: true},
		RecordingID:    pgtype.UUID{Bytes: mustID(t, "bc390000-0000-4000-8000-000000000005").Bytes(), Valid: true},
		CaptureJobID:   pgtype.UUID{Bytes: mustID(t, "bc390000-0000-4000-8000-000000000006").Bytes(), Valid: true},
		IdempotencyKey: "preparation-materialization", RequestFingerprint: bytes.Repeat([]byte{1}, 32),
		PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, EpisodeCount: 1, ParticipantCount: 3,
		InputBitrateBps: 3_000_000, MaxDurationSeconds: 3600, PayloadSchemaVersion: 1, AttemptLimit: 5,
		AvailableAt: input.ObservedAt, EndsAt: pgtype.Timestamptz{Time: now.Add(time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertPreparationDemand(t, queries, now, 1)
	status, err = queries.GetRecordingPreparation(ctx, sqlc.GetRecordingPreparationParams{TenantID: input.TenantID, SpaceID: input.SpaceID, ObservedAt: input.ObservedAt})
	if err != nil || status.State != "consumed" || !status.ConsumedRecordingID.Valid {
		t.Fatalf("consumed status = %+v, %v", status, err)
	}
	cancelInput.ExpectedRevision = status.Revision
	if canceled, err := queries.CancelRecordingPreparation(ctx, cancelInput); err != nil || canceled.State != "consumed" {
		t.Fatalf("cancel active recording = %+v, %v", canceled, err)
	}
	assertPreparationDemand(t, queries, now, 1)
}

func assertPreparationDemand(t *testing.T, queries *sqlc.Queries, now time.Time, want int32) {
	t.Helper()
	demand, err := queries.GetRecordingFleetDemand(t.Context(), sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: now, Valid: true}})
	if err != nil || demand.DesiredNodes != want {
		t.Fatalf("capture demand = %+v, %v; want %d", demand, err, want)
	}
}
