package postgres

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestRecordingAdmissionCapsPostgres(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	for _, tc := range []struct {
		name                   string
		limits                 recordingpipeline.AdmissionLimits
		episodes, participants int
		bitrate                int64
		admitted               bool
	}{
		{"default recording cap", recordingpipeline.AdmissionLimits{}, 10, 0, 0, false},
		{"default participant cap", recordingpipeline.AdmissionLimits{}, 0, 100, 0, false},
		{"default bitrate cap", recordingpipeline.AdmissionLimits{}, 0, 0, 40_000_000, false},
		{"raised recording cap", recordingpipeline.AdmissionLimits{RecordingCap: 20, ParticipantCap: 200}, 19, 190, 76_000_000, true},
		{"raised recording ceiling", recordingpipeline.AdmissionLimits{RecordingCap: 20, ParticipantCap: 200}, 20, 0, 0, false},
		{"raised participant ceiling", recordingpipeline.AdmissionLimits{RecordingCap: 20, ParticipantCap: 150}, 0, 150, 0, false},
		{"raised participant boundary", recordingpipeline.AdmissionLimits{RecordingCap: 20, ParticipantCap: 150}, 0, 140, 0, true},
		{"raised bitrate ceiling", recordingpipeline.AdmissionLimits{RecordingCap: 20, ParticipantCap: 200}, 0, 0, 80_000_000, false},
		{"lowered recording cap", recordingpipeline.AdmissionLimits{RecordingCap: 1, ParticipantCap: 10}, 1, 0, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			exec := func(sql string, args ...any) {
				t.Helper()
				if _, err := tx.Exec(ctx, sql, args...); err != nil {
					t.Fatal(err)
				}
			}
			tenant, space, episode := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
			exec(`insert into tenants(id,name) values($1,'caps proof')`, tenant.Bytes())
			exec(`insert into spaces(id,tenant_id,name,slug,media_plane,recording_policy) values($1,$2,'caps proof',$1::uuid::text,'cf_sfu','manual')`, space.Bytes(), tenant.Bytes())
			exec(`insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'active','{}')`, episode.Bytes(), tenant.Bytes(), space.Bytes())
			exec(`update recording_capacity set reserved_episodes=$1,reserved_participants=$2,reserved_input_bitrate_bps=$3 where id=1`, tc.episodes, tc.participants, tc.bitrate)
			q := sqlc.New(tx)
			now := time.Now().UTC()
			limits := tc.limits.WithDefaults()
			_, err = q.CreateRecordingReservation(ctx, sqlc.CreateRecordingReservationParams{
				TenantID: uuid(tenant), SpaceID: uuid(space), EpisodeID: uuid(episode), ID: uuid(accountTenantIntegrationID(t)), RecordingID: uuid(accountTenantIntegrationID(t)), CaptureJobID: uuid(accountTenantIntegrationID(t)),
				IdempotencyKey: "caps-proof", RequestFingerprint: bytes.Repeat([]byte{1}, 32), PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
				EpisodeCount: 1, ParticipantCount: 10, InputBitrateBps: recordingpipeline.MaximumInputBitrateBPS, MaxDurationSeconds: 3600, PayloadSchemaVersion: 1, AttemptLimit: 5,
				AvailableAt: timestamptzValue(now), EndsAt: timestamptzValue(now.Add(time.Hour)), RecordingCap: int32(limits.RecordingCap), ParticipantCap: int32(limits.ParticipantCap), BitrateCapBps: limits.BitrateCapBPS(),
			})
			if tc.admitted && err != nil || !tc.admitted && !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("admitted=%v error=%v", tc.admitted, err)
			}
			var episodes, participants int
			var bitrate int64
			if err := tx.QueryRow(ctx, `select reserved_episodes,reserved_participants,reserved_input_bitrate_bps from recording_capacity where id=1`).Scan(&episodes, &participants, &bitrate); err != nil {
				t.Fatal(err)
			}
			increment := 0
			if tc.admitted {
				increment = 1
			}
			if episodes != tc.episodes+increment || participants != tc.participants+10*increment || bitrate != tc.bitrate+int64(increment)*4_000_000 {
				t.Fatalf("capacity=%d/%d/%d", episodes, participants, bitrate)
			}
		})
	}
}

func TestRecordingPreparationCapsPostgres(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Isolate time-dependent fleet demand from the other integration fixtures.
	exec(`update recording_reservations set state='released' where state='reserved'`)
	exec(`update recording_jobs set state='cancelled' where state in ('pending','retryable_failure','leased')`)
	exec(`update recording_preparations set state='canceled' where state='scheduled'`)
	tenant, space := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec(`insert into tenants(id,name) values($1,'preparation caps')`, tenant.Bytes())
	exec(`insert into spaces(id,tenant_id,name,slug,media_plane,recording_policy) values($1,$2,'caps proof',$1::uuid::text,'cf_sfu','manual')`, space.Bytes(), tenant.Bytes())
	exec(`update recording_capacity set reserved_episodes=10,reserved_participants=100,reserved_input_bitrate_bps=40000000 where id=1`)
	now := time.Now().UTC()
	q := sqlc.New(tx)
	_, err = q.PrepareRecordingSpace(ctx, sqlc.PrepareRecordingSpaceParams{TenantID: uuid(tenant), SpaceID: uuid(space), StartsAt: timestamptzValue(now), ObservedAt: timestamptzValue(now)})
	if err != nil {
		t.Fatal(err)
	}
	for _, cap := range []int32{0, 10, 20} {
		row, err := q.GetRecordingPreparation(ctx, sqlc.GetRecordingPreparationParams{TenantID: uuid(tenant), SpaceID: uuid(space), ObservedAt: timestamptzValue(now), RecordingCap: cap})
		if err != nil || row.CapacityAvailable != (cap == 20) {
			t.Fatalf("cap %d preparation=%+v, %v", cap, row, err)
		}
	}
	// Twenty distinct preparations exercise the SQL preparation-demand ceiling.
	for i := 1; i < 20; i++ {
		id := accountTenantIntegrationID(t)
		exec(`insert into spaces(id,tenant_id,name,slug,media_plane,recording_policy) values($1,$2,'caps proof',$1::uuid::text,'cf_sfu','manual')`, id.Bytes(), tenant.Bytes())
		_, err = q.PrepareRecordingSpace(ctx, sqlc.PrepareRecordingSpaceParams{TenantID: uuid(tenant), SpaceID: uuid(id), StartsAt: timestamptzValue(now), ObservedAt: timestamptzValue(now)})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, cap := range []int32{0, 10, 20} {
		want := cap
		if want == 0 {
			want = 10
		}
		row, err := q.GetRecordingFleetDemand(ctx, sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: timestamptzValue(now), RecordingCap: cap})
		if err != nil || row.DesiredNodes != want || row.SlotDemand != want {
			t.Fatalf("cap %d demand=%+v, %v", cap, row, err)
		}
	}
}

func TestRecordingParticipantMigrationPostgres(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	// A temporary copy tests the real migration without changing the shared schema.
	exec(`create temporary table recording_capacity (id smallint primary key check(id=1),reserved_episodes integer not null default 0 check(reserved_episodes between 0 and 20),reserved_participants integer not null default 0 constraint recording_capacity_reserved_participants_check1 check(reserved_participants between 0 and 100),reserved_input_bitrate_bps bigint not null default 0 check(reserved_input_bitrate_bps>=0),updated_at timestamptz not null default now())`)
	exec(`insert into recording_capacity(id) values(1)`)
	migration, err := migrations.Files.ReadFile("20261025000000_recording_admission_participants.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, down, ok := strings.Cut(string(migration), "-- +goose Down")
	if !ok {
		t.Fatal("missing Down")
	}
	exec(up)
	exec(`update recording_capacity set reserved_episodes=20,reserved_participants=200,reserved_input_bitrate_bps=80000000 where id=1`)
	exec(`savepoint blocked_down`)
	if _, err := tx.Exec(ctx, down); err == nil || !strings.Contains(err.Error(), "drain reservations first") {
		t.Fatalf("unsafe Down error=%v", err)
	}
	exec(`rollback to savepoint blocked_down`)
	exec(`update recording_capacity set reserved_participants=100 where id=1`)
	// The old API's maximum counters remain legal after Up.
	exec(down)
	exec(`savepoint old_bound`)
	if _, err := tx.Exec(ctx, `update recording_capacity set reserved_participants=101 where id=1`); err == nil {
		t.Fatal("Down accepted 101")
	}
	exec(`rollback to savepoint old_bound`)
	exec(up)
	var bounds string
	if err := tx.QueryRow(ctx, `select string_agg(pg_get_constraintdef(oid),';' order by conname) from pg_constraint where conrelid='pg_temp.recording_capacity'::regclass`).Scan(&bounds); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"reserved_episodes <= 20", "reserved_participants <= 200", "reserved_input_bitrate_bps >= 0"} {
		if !strings.Contains(bounds, text) {
			t.Fatal(fmt.Sprintf("missing %s in %s", text, bounds))
		}
	}
}
