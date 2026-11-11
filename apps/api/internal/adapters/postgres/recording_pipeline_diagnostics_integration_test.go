package postgres_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingMaintenanceTransitionDiagnostics(t *testing.T) {
	pool := stoppedCompletionPool(t)
	newID := func() utilities.ID {
		t.Helper()
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	for _, scenario := range []string{"maintenance", "preclaim", "expiry", "recovery rollback", "expiry rollback", "expiry failure after recovery"} {
		t.Run(scenario, func(t *testing.T) {
			tx, err := pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			fixture := struct{ recordingID, jobID utilities.ID }{newID(), newID()}
			tenantID, spaceID, episodeID, reservationID := newID(), newID(), newID(), newID()
			expiry := scenario == "expiry" || scenario == "expiry rollback"
			execCleanupFixture(t, tx, `insert into tenants(id,name) values($1,'diagnostics fixture')`, tenantID.Bytes())
			execCleanupFixture(t, tx, `insert into spaces(id,name,tenant_id,slug,media_plane) values($1,'diagnostics fixture',$2,$3,'cf_sfu')`, spaceID.Bytes(), tenantID.Bytes(), spaceID.String())
			execCleanupFixture(t, tx, `insert into episodes(id,status,space_id,tenant_id,config_snapshot) values($1,'active',$2,$3,'{}')`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes())
			execCleanupFixture(t, tx, `insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values($1,$2,$3,$4,'recording','r2')`, fixture.recordingID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes())
			execCleanupFixture(t, tx, `insert into recording_reservations(id,tenant_id,space_id,episode_id,recording_id,idempotency_key,request_fingerprint,policy_snapshot_version,participant_count,max_duration_seconds,input_bitrate_bps,state,ends_at)
    values($1,$2,$3,$4,$5,$6,decode(repeat('ab',32),'hex'),'episode_config.v2',1,3600,1000,'reserved',now()+interval '1 hour')`, reservationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), fixture.recordingID.Bytes(), reservationID.String())
			execCleanupFixture(t, tx, `insert into recording_pipelines(recording_id,tenant_id,reservation_id,state,capture_epoch,stop_requested_at,stop_operation_id) values($1,$2,$3,'reserved',1,case when $4 then null else now() end,case when $4 then null else $5::uuid end)`, fixture.recordingID.Bytes(), tenantID.Bytes(), reservationID.Bytes(), expiry, newID().Bytes())
			execCleanupFixture(t, tx, `insert into recording_jobs(id,tenant_id,episode_id,recording_id,kind,idempotency_key,payload_schema_version,state,available_at,attempt_limit) values($1,$2,$3,$4,'capture',$5,1,'pending',now(),3)`, fixture.jobID.Bytes(), tenantID.Bytes(), episodeID.Bytes(), fixture.recordingID.Bytes(), fixture.jobID.String())
			execCleanupFixture(t, tx, `update recording_capacity set reserved_episodes=reserved_episodes+1,reserved_participants=reserved_participants+1,reserved_input_bitrate_bps=reserved_input_bitrate_bps+1000 where id=1`)
			failCommit := scenario == "recovery rollback" || scenario == "expiry rollback"
			repository := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(tx), diagnosticTransactor{Tx: tx, failCommit: failCommit}, func(q sqlc.Querier) sqlc.Querier {
				if scenario == "expiry failure after recovery" {
					return diagnosticExpiryFailure{Querier: q}
				}
				return q
			})
			service := recordingpipeline.NewService(repository)
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			var logs bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(diagnosticMaintenanceHandler{Handler: slog.NewJSONHandler(&logs, nil), cancel: cancel}))
			t.Cleanup(func() { slog.SetDefault(previous) })
			now := time.Now().UTC().Add(11 * time.Minute)
			switch scenario {
			case "maintenance", "expiry failure after recovery":
				if err := service.RunMaintenance(ctx, time.Hour); err != nil {
					t.Fatal(err)
				}
				if errors.Is(ctx.Err(), context.DeadlineExceeded) {
					t.Fatal("maintenance did not finish its first cycle")
				}
			case "preclaim":
				claimID, err := utilities.NewID()
				if err != nil {
					t.Fatal(err)
				}
				if _, err := service.Claim(ctx, recordingpipeline.ClaimInput{Kind: recordingpipeline.JobKindCapture, ClaimRequestID: claimID, Owner: "synthetic-worker", LeaseToken: "synthetic-token", LeaseFor: time.Minute}); err == nil {
					t.Fatal("terminal capture was claimed")
				}
			case "expiry", "expiry rollback":
				_, err := service.ExpireReservations(ctx, now)
				if (err != nil) != failCommit {
					t.Fatalf("expiry error = %v", err)
				}
			default:
				if _, err := service.RecoverExpired(ctx); err == nil {
					t.Fatal("injected commit failure succeeded")
				}
			}
			var events []map[string]any
			decoder := json.NewDecoder(&logs)
			for decoder.More() {
				var event map[string]any
				if err := decoder.Decode(&event); err != nil {
					t.Fatal(err)
				}
				if event["event"] == "recording.job_recovered" || event["event"] == "recording.reservation_expired" {
					events = append(events, event)
				}
			}
			var state, code string
			if err := tx.QueryRow(t.Context(), `select state,coalesce(error_code,'') from recording_jobs where id=$1`, fixture.jobID.Bytes()).Scan(&state, &code); err != nil {
				t.Fatal(err)
			}
			if failCommit {
				if len(events) != 0 || state != "pending" || code != "" {
					t.Fatalf("rolled-back transition leaked: events=%v state=%s code=%s", events, state, code)
				}
				return
			}
			if len(events) != 1 || state != "terminal_failure" {
				t.Fatalf("committed transition evidence: events=%v state=%s", events, state)
			}
			event := events[0]
			for key, want := range map[string]any{"tenant_id": tenantID.String(), "episode_id": episodeID.String(), "recording_id": fixture.recordingID.String()} {
				if event[key] != want {
					t.Errorf("%s=%v, want %v", key, event[key], want)
				}
			}
			if event["transition_at"] == nil {
				t.Fatal("missing committed transition time")
			}
			if expiry {
				if code != "capture_reservation_expired" || event["reason"] != code || event["state"] != "expired" || event["reservation_id"] != reservationID.String() || event["space_id"] != spaceID.String() {
					t.Fatalf("expiry evidence=%v code=%s", event, code)
				}
			} else {
				if code != "capture_stopped_before_completion" || event["reason"] != code || event["state"] != state || event["job_id"] != fixture.jobID.String() || event["capture_outcome"] != "stopped_before_claim" || event["attempt_count"] != float64(0) {
					t.Fatalf("preclaim evidence=%v code=%s", event, code)
				}
			}
			// No changed row means no duplicate transition evidence on maintenance retry.
			logs.Reset()
			if _, err := repository.RecoverExpired(t.Context()); err != nil {
				t.Fatal(err)
			}
			if scenario != "expiry failure after recovery" {
				if _, err := repository.ExpireReservations(t.Context(), now); err != nil {
					t.Fatal(err)
				}
			}
			if logs.Len() != 0 {
				t.Fatalf("no-op retry emitted transition evidence: %s", logs.String())
			}
		})
	}
}

type diagnosticMaintenanceHandler struct {
	slog.Handler
	cancel context.CancelFunc
}

func (h diagnosticMaintenanceHandler) Handle(ctx context.Context, record slog.Record) error {
	err := h.Handler.Handle(ctx, record)
	record.Attrs(func(a slog.Attr) bool {
		if a.Key == "event" && (a.Value.String() == "recording.pipeline_maintenance.completed" || a.Value.String() == "recording.pipeline_maintenance.failed") {
			h.cancel()
		}
		return true
	})
	return err
}

type diagnosticTransactor struct {
	pgx.Tx
	failCommit bool
}

func (t diagnosticTransactor) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	tx, err := t.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return diagnosticTransaction{Tx: tx, failCommit: t.failCommit}, nil
}

type diagnosticTransaction struct {
	pgx.Tx
	failCommit bool
}

func (t diagnosticTransaction) Commit(ctx context.Context) error {
	if t.failCommit {
		return errors.New("injected commit failure")
	}
	return t.Tx.Commit(ctx)
}

type diagnosticExpiryFailure struct{ sqlc.Querier }

func (q diagnosticExpiryFailure) ExpireRecordingReservations(context.Context, pgtype.Timestamptz) ([]sqlc.ExpireRecordingReservationsRow, error) {
	return nil, errors.New("injected expiry failure")
}
