package postgres_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
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

type ownSFUPlaneCase struct {
	name          string
	tenantDefault string
	spacePlane    string
	pinned        string // provider of the Space's active Episode binding, "" for no Episode
	ownCapture    bool
	allowed       bool
}

// The plane a preparation is judged on is the active Episode's pinned binding, else the Space's
// selection, else the Tenant's default. Without own capture the own SFU holds no preparation.
var ownSFUPlaneCases = []ownSFUPlaneCase{
	{"space selects the own SFU", "", "chalk_sfu", "", false, false},
	{"tenant default is the own SFU", "chalk_sfu", "", "", false, false},
	{"space overrides a tenant default", "chalk_sfu", "cf_sfu", "", false, true},
	{"cloudflare control", "", "cf_sfu", "", false, true},
	{"space selects the own SFU with capture on", "", "chalk_sfu", "", true, true},
	{"tenant default is the own SFU with capture on", "chalk_sfu", "", "", true, true},
	{"live Cloudflare Episode keeps its recorder after the Space switches", "", "chalk_sfu", "cf_sfu", false, true},
	{"live own SFU Episode gets no recorder after the Space switches back", "", "cf_sfu", "chalk_sfu", false, false},
	{"live own SFU Episode with capture on", "", "cf_sfu", "chalk_sfu", true, true},
}

func seedOwnSFUPlane(t *testing.T, pool *pgxpool.Pool, test ownSFUPlaneCase, tenant, space, episode utilities.ID) {
	t.Helper()
	var defaultPlane any
	if test.tenantDefault != "" {
		defaultPlane = test.tenantDefault
	}
	if _, err := pool.Exec(t.Context(), `insert into tenants (id,name,default_media_plane) values ($1,'Own SFU proof',$2)`, tenant.Bytes(), defaultPlane); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from episodes where tenant_id=$1`, tenant.Bytes())
		pool.Exec(context.Background(), `delete from tenants where id=$1`, tenant.Bytes())
	})
	if _, err := pool.Exec(t.Context(), `insert into spaces (id,tenant_id,name,slug,media_plane,recording_policy) values ($1,$2,'Own SFU proof','own-sfu-proof',$3,'automatic')`, space.Bytes(), tenant.Bytes(), test.spacePlane); err != nil {
		t.Fatal(err)
	}
	if test.pinned != "" {
		snapshot := fmt.Sprintf(`{"media_plane_binding":{"provider":%q}}`, test.pinned)
		if _, err := pool.Exec(t.Context(), `insert into episodes (id,status,space_id,tenant_id,config_snapshot) values ($1,'active',$2,$3,$4::jsonb)`, episode.Bytes(), space.Bytes(), tenant.Bytes(), snapshot); err != nil {
			t.Fatal(err)
		}
	}
}

func ownSFUPlanePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), os.Getenv(config.DatabaseURL))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return pool
}

func TestEntranceFollowsTheOwnSFUCaptureSwitch(t *testing.T) {
	pool := ownSFUPlanePool(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for i, test := range ownSFUPlaneCases {
		t.Run(test.name, func(t *testing.T) {
			tenant, space, episode := mustID(t, fmt.Sprintf("bc390000-0000-4000-8000-0000000001%02d", i)), mustID(t, fmt.Sprintf("bc390000-0000-4000-8000-0000000002%02d", i)), mustID(t, fmt.Sprintf("bc390000-0000-4000-8000-0000000003%02d", i))
			seedOwnSFUPlane(t, pool, test, tenant, space, episode)
			created, err := postgres.NewRecordingPreparationRepository(pool).WithOwnCapture(test.ownCapture).PrepareEntrance(t.Context(), tenant, space, now)
			if err != nil || created != test.allowed {
				t.Fatalf("Entrance preparation = %v, %v; want %v", created, err, test.allowed)
			}
		})
	}
}

func TestScheduledPreparationFollowsTheOwnSFUCaptureSwitch(t *testing.T) {
	pool := ownSFUPlanePool(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for i, test := range ownSFUPlaneCases {
		t.Run(test.name, func(t *testing.T) {
			tenant, space, episode := mustID(t, fmt.Sprintf("bc390000-0000-4000-8000-0000000004%02d", i)), mustID(t, fmt.Sprintf("bc390000-0000-4000-8000-0000000005%02d", i)), mustID(t, fmt.Sprintf("bc390000-0000-4000-8000-0000000006%02d", i))
			seedOwnSFUPlane(t, pool, test, tenant, space, episode)
			// A policy denial, never a revision conflict, whether the Space or its Tenant selects the own SFU.
			_, err := postgres.NewRecordingPreparationRepository(pool).WithOwnCapture(test.ownCapture).Prepare(t.Context(), recordingpreparation.Input{TenantID: tenant, SpaceID: space, StartsAt: now.Add(time.Hour)}, now)
			if test.allowed != (err == nil) || (!test.allowed && !errors.Is(err, recordingpreparation.ErrPolicyDenied)) {
				t.Fatalf("scheduled preparation = %v; want allowed %v", err, test.allowed)
			}
			var rows int
			if err := pool.QueryRow(t.Context(), `select count(*) from recording_preparations where space_id=$1`, space.Bytes()).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if (rows == 1) != test.allowed {
				t.Fatalf("preparation rows = %d, allowed = %v", rows, test.allowed)
			}
		})
	}
}

// A preparation made under another plane must not warm a recorder nobody can use.
func TestExistingPreparationStopsCountingWhenTheSpaceSwitchesToTheOwnSFU(t *testing.T) {
	pool := ownSFUPlanePool(t)
	tenant, space := mustID(t, "bc390000-0000-4000-8000-000000000701"), mustID(t, "bc390000-0000-4000-8000-000000000702")
	seedOwnSFUPlane(t, pool, ownSFUPlaneCase{spacePlane: "cf_sfu"}, tenant, space, utilities.ID{})
	now := time.Now().UTC().Truncate(time.Microsecond)
	if created, err := postgres.NewRecordingPreparationRepository(pool).PrepareEntrance(t.Context(), tenant, space, now); err != nil || !created {
		t.Fatalf("Entrance preparation = %v, %v", created, err)
	}
	queries := sqlc.New(pool)
	demand := func(ownCapture bool) int32 {
		row, err := queries.GetRecordingFleetDemand(t.Context(), sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: now, Valid: true}, OwnCapture: ownCapture})
		if err != nil {
			t.Fatal(err)
		}
		return row.DesiredNodes
	}
	counted := demand(false)
	if _, err := pool.Exec(t.Context(), `update spaces set media_plane='chalk_sfu' where id=$1`, space.Bytes()); err != nil {
		t.Fatal(err)
	}
	if got := demand(false); got != counted-1 {
		t.Fatalf("fleet demand with capture off = %d, want %d after the switch", got, counted-1)
	}
	if got := demand(true); got != counted {
		t.Fatalf("fleet demand with capture on = %d, want %d", got, counted)
	}
	for _, ownCapture := range []bool{false, true} {
		preparation, err := postgres.NewRecordingPreparationRepository(pool).WithOwnCapture(ownCapture).Get(t.Context(), tenant, space, now)
		if err != nil {
			t.Fatal(err)
		}
		if !ownCapture && (preparation.CapacityAvailable || preparation.Ready) {
			t.Fatalf("preparation with capture off = %+v, want no capacity", preparation)
		}
	}
}

func TestAutomaticEntrancePreparation(t *testing.T) {
	pool, err := pgxpool.New(t.Context(), os.Getenv(config.DatabaseURL))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tenant := mustID(t, "bc390000-0000-4000-8000-000000000021")
	space := mustID(t, "bc390000-0000-4000-8000-000000000022")
	_, err = pool.Exec(t.Context(), `insert into tenants (id,name) values ($1,'Entrance proof');`, tenant.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(context.Background(), `delete from tenants where id=$1`, tenant.Bytes())
	_, err = pool.Exec(t.Context(), `insert into spaces (id,tenant_id,name,slug,media_plane,recording_policy) values ($1,$2,'Entrance proof','entrance-proof','cf_sfu','automatic')`, space.Bytes(), tenant.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewRecordingPreparationRepository(pool)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for _, policy := range []string{"manual", "disabled", "automatic"} {
		t.Run(policy, func(t *testing.T) {
			if _, err := pool.Exec(t.Context(), `update spaces set recording_policy=$2 where id=$1`, space.Bytes(), policy); err != nil {
				t.Fatal(err)
			}
			created, err := repository.PrepareEntrance(t.Context(), tenant, space, now)
			if err != nil || created != (policy == "automatic") {
				t.Fatalf("Entrance preparation = %v, %v", created, err)
			}
		})
	}
	var group sync.WaitGroup
	results := make(chan error, 20)
	for i := 0; i < 20; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			created, err := repository.PrepareEntrance(t.Context(), tenant, space, now.Add(time.Second))
			if err == nil && created {
				err = errors.New("concurrent Entrance extended deadline")
			}
			results <- err
		}()
	}
	group.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 10; i++ {
		if created, err := repository.PrepareEntrance(t.Context(), tenant, space, now.Add(time.Duration(i+1)*time.Second)); err != nil || created {
			t.Fatalf("repeated Entrance = %v, %v", created, err)
		}
	}
	var count int
	var starts time.Time
	if err := pool.QueryRow(t.Context(), `select count(*),max(starts_at) from recording_preparations where space_id=$1`, space.Bytes()).Scan(&count, &starts); err != nil || count != 1 || !starts.Equal(now) {
		t.Fatalf("bounded preparation: count=%d starts=%v err=%v", count, starts, err)
	}
	q := sqlc.New(pool)
	demand, err := q.GetRecordingFleetDemand(t.Context(), sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: now.Add(5 * time.Minute), Valid: true}})
	if err != nil || demand.ScheduledPrewarms != 0 {
		t.Fatalf("abandoned Entrance demand = %+v, %v", demand, err)
	}
	if _, err := q.ExpireRecordingReservations(t.Context(), pgtype.Timestamptz{Time: now.Add(5 * time.Minute), Valid: true}); err != nil {
		t.Fatal(err)
	}
	preparation, err := repository.Get(t.Context(), tenant, space, now.Add(5*time.Minute))
	if err != nil || preparation.State != "expired" {
		t.Fatalf("abandoned Entrance = %+v, %v", preparation, err)
	}
	// A fresh Entrance after expiry can warm again; joining consumes that demand.
	if created, err := repository.PrepareEntrance(t.Context(), tenant, space, now); err != nil || !created {
		t.Fatalf("fresh Entrance = %v, %v", created, err)
	}
	episode := mustID(t, "bc390000-0000-4000-8000-000000000023")
	if _, err := pool.Exec(t.Context(), `insert into episodes (id,tenant_id,space_id,status,config_snapshot) values ($1,$2,$3,'active','{}'::jsonb)`, episode.Bytes(), tenant.Bytes(), space.Bytes()); err != nil {
		t.Fatal(err)
	}

	// Starting Recording demand must not revive an expired preparation.
	if _, err := q.ExpireRecordingReservations(t.Context(), pgtype.Timestamptz{Time: now.Add(5 * time.Minute), Valid: true}); err != nil {
		t.Fatal(err)
	}
	recording := mustID(t, "bc390000-0000-4000-8000-000000000027")
	if _, err := pool.Exec(t.Context(), `insert into recordings (id,tenant_id,space_id,episode_id,status,storage_provider) values ($1,$2,$3,$4,'pending','r2')`, recording.Bytes(), tenant.Bytes(), space.Bytes(), episode.Bytes()); err != nil {
		t.Fatal(err)
	}
	if created, err := repository.PrepareEntrance(t.Context(), tenant, space, now); err != nil || created {
		t.Fatalf("starting Recording pre-warm = %v, %v", created, err)
	}
	if _, err := pool.Exec(t.Context(), `delete from recordings where id=$1`, recording.Bytes()); err != nil {
		t.Fatal(err)
	}
	preparation, err = repository.Get(t.Context(), tenant, space, now.Add(5*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.PrepareRecordingSpace(t.Context(), sqlc.PrepareRecordingSpaceParams{TenantID: pgtype.UUID{Bytes: tenant.Bytes(), Valid: true}, SpaceID: pgtype.UUID{Bytes: space.Bytes(), Valid: true}, StartsAt: pgtype.Timestamptz{Time: now.Add(time.Hour), Valid: true}, ObservedAt: pgtype.Timestamptz{Time: now, Valid: true}, ExpectedRevision: preparation.Revision}); err != nil {
		t.Fatal(err)
	}
	if created, err := repository.PrepareEntrance(t.Context(), tenant, space, now); err != nil || !created {
		t.Fatalf("Entrance should advance a future preparation = %v, %v", created, err)
	}
	// Roll back Recording admission and global capacity changes after the proof.
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	q = sqlc.New(tx)
	if _, err := q.LockRecordingCapacity(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `update recording_capacity set reserved_episodes=0,reserved_participants=0,reserved_input_bitrate_bps=0 where id=1`); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	reservation, err := q.CreateRecordingReservation(ctx, sqlc.CreateRecordingReservationParams{
		TenantID: pgtype.UUID{Bytes: tenant.Bytes(), Valid: true}, SpaceID: pgtype.UUID{Bytes: space.Bytes(), Valid: true}, EpisodeID: pgtype.UUID{Bytes: episode.Bytes(), Valid: true},
		ID:             pgtype.UUID{Bytes: mustID(t, "bc390000-0000-4000-8000-000000000024").Bytes(), Valid: true},
		RecordingID:    pgtype.UUID{Bytes: mustID(t, "bc390000-0000-4000-8000-000000000025").Bytes(), Valid: true},
		CaptureJobID:   pgtype.UUID{Bytes: mustID(t, "bc390000-0000-4000-8000-000000000026").Bytes(), Valid: true},
		IdempotencyKey: "preparation-materialization", RequestFingerprint: bytes.Repeat([]byte{1}, 32),
		PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, EpisodeCount: 1, ParticipantCount: 3,
		InputBitrateBps: 3_000_000, MaxDurationSeconds: 3600, PayloadSchemaVersion: 1, AttemptLimit: 5,
		AvailableAt: pgtype.Timestamptz{Time: now, Valid: true}, EndsAt: pgtype.Timestamptz{Time: now.Add(time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	status, err := q.GetRecordingPreparation(t.Context(), sqlc.GetRecordingPreparationParams{TenantID: pgtype.UUID{Bytes: tenant.Bytes(), Valid: true}, SpaceID: pgtype.UUID{Bytes: space.Bytes(), Valid: true}, ObservedAt: pgtype.Timestamptz{Time: now, Valid: true}})
	if err != nil || status.State != "consumed" || status.ConsumedRecordingID != reservation.RecordingID || !reservation.PreparationConsumed {
		t.Fatalf("join consumption = %+v, %+v, %v", status, reservation, err)
	}
	demand, err = q.GetRecordingFleetDemand(t.Context(), sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: now, Valid: true}})
	if err != nil || demand.DesiredNodes != 1 || demand.ScheduledPrewarms != 0 {
		t.Fatalf("join must reuse warm demand: %+v, %v", demand, err)
	}

}
