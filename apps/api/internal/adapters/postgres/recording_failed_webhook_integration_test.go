package postgres_test

import (
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// A capture whose lease ran out for the last time never reaches Fail, so recovery is the only
// path that can tell a subscriber the Recording failed.
func TestLeaseRecoveryPublishesTheRecordingFailedWebhook(t *testing.T) {
	ctx := t.Context()
	tx, f := newAllocationCleanupFixture(t, true, "capture")
	defer tx.Rollback(ctx)
	execCleanupFixture(t, tx, `update recording_jobs set attempt_limit = 1 where id = $1`, f.jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_capacity set reserved_episodes = reserved_episodes + 1,
		reserved_participants = reserved_participants + 1, reserved_input_bitrate_bps = reserved_input_bitrate_bps + 1000 where id = 1`)
	execCleanupFixture(t, tx, `update recordings set status = 'pending' where id = $1`, f.recordingID.Bytes())
	subscribeToRecordingFailures(t, tx, f.recordingID)

	if _, err := transactionalPipelineRepository(tx).RecoverExpired(ctx); err != nil {
		t.Fatalf("recover expired: %v", err)
	}
	var events int
	var code string
	if err := tx.QueryRow(ctx, `select count(*), coalesce(max(convert_from(body, 'UTF8')::jsonb #>> '{data,object,failure,code}'), '')
		from webhook_events where resource_id = $1 and event_name = 'recording.failed'`, f.recordingID.Bytes()).Scan(&events, &code); err != nil {
		t.Fatal(err)
	}
	facts := readRecordingFacts(t, tx, f.recordingID)
	if events != 1 || facts.failureCode == nil || code != *facts.failureCode {
		t.Fatalf("recovery must publish one recording.failed carrying the stored code: events=%d webhook_code=%q facts=%+v", events, code, facts)
	}
}

func TestRecordingFailureWebhookIsNotQueuedAgainAfterExportRetry(t *testing.T) {
	for _, tc := range []struct {
		name    string
		expired bool
	}{
		{"retained webhook", false},
		{"expired webhook with capture still retained", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			tx, f := newAllocationCleanupFixture(t, true, "render")
			defer tx.Rollback(ctx)
			startEmptyCapture(t, tx, f.recordingID)
			subscribeToRecordingFailures(t, tx, f.recordingID)
			execCleanupFixture(t, tx, `update recording_reservations set state = 'released' where recording_id = $1`, f.recordingID.Bytes())
			execCleanupFixture(t, tx, `update recording_jobs set attempt_limit = 1 where id = $1`, f.jobID.Bytes())

			repository := transactionalPipelineRepository(tx)
			fail := func() {
				t.Helper()
				if _, err := repository.RecoverExpired(ctx); err != nil {
					t.Fatalf("fail expired render lease: %v", err)
				}
				if facts := readRecordingFacts(t, tx, f.recordingID); facts.status != "failed" {
					t.Fatalf("Recording did not become failed: %+v", facts)
				}
			}
			assertWebhooks := func(want int) {
				t.Helper()
				var events, deliveries int
				if err := tx.QueryRow(ctx, `select count(distinct event.id), count(delivery.id)
					from webhook_events event left join webhook_deliveries delivery on delivery.event_id = event.id
					where event.resource_id = $1 and event.event_name = 'recording.failed'`, f.recordingID.Bytes()).Scan(&events, &deliveries); err != nil {
					t.Fatal(err)
				}
				if events != want || deliveries != want {
					t.Fatalf("webhook events = %d, deliveries = %d; want %d of each", events, deliveries, want)
				}
			}
			fail()
			assertWebhooks(1)

			var tenant string
			if err := tx.QueryRow(ctx, `select tenant_id::text from recordings where id = $1`, f.recordingID.Bytes()).Scan(&tenant); err != nil {
				t.Fatal(err)
			}
			tenantID, err := utilities.ParseID(tenant)
			if err != nil {
				t.Fatal(err)
			}
			want := 1
			if tc.expired {
				// Webhook retention can elapse before capture retention. Age only
				// the event to exercise cleanup without expiring the capture.
				execCleanupFixture(t, tx, `update webhook_events set occurred_at = now() - interval '31 days' where resource_id = $1`, f.recordingID.Bytes())
				queries := sqlc.New(tx)
				if _, err := queries.CleanupExpiredWebhookDeliveries(ctx); err != nil {
					t.Fatal(err)
				}
				if _, err := queries.CleanupExpiredWebhookEvents(ctx); err != nil {
					t.Fatal(err)
				}
				want = 0
				assertWebhooks(want)
			}
			newJobID, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			job, err := repository.RequestExport(ctx, recordingpipeline.ExportInput{TenantID: tenantID, RecordingID: f.recordingID}, newJobID)
			if err != nil || job.State != recordingpipeline.JobStatePending {
				t.Fatalf("retry Export: state=%s, err=%v", job.State, err)
			}
			execCleanupFixture(t, tx, `update recording_jobs set state = 'leased', attempt_count = 1,
				fencing_generation = 2, lease_token = 'retry-token', lease_owner = 'retry-worker',
				lease_expires_at = now() - interval '1 minute' where id = $1`, f.jobID.Bytes())
			fail()
			assertWebhooks(want)
			var failures int
			if err := tx.QueryRow(ctx, `select count(*) from observability_journey_events
				where name = 'recording.failed' and attributes->>'recording_id' = $1`, f.recordingID.String()).Scan(&failures); err != nil || failures != 2 {
				t.Fatalf("want both terminal transitions in the journey ledger: failures=%d err=%v", failures, err)
			}
		})
	}
}

func subscribeToRecordingFailures(t *testing.T, tx pgx.Tx, recordingID utilities.ID) {
	t.Helper()
	execCleanupFixture(t, tx, `insert into webhook_endpoints (id, tenant_id, name, enabled, revision, current_target_revision, current_secret_ciphertext)
		select gen_random_uuid(), tenant_id, 'recovery subscriber', true, 1, 1, '\x01' from recordings where id = $1`, recordingID.Bytes())
	execCleanupFixture(t, tx, `insert into webhook_endpoint_revisions (id, tenant_id, endpoint_id, revision, url_ciphertext, url_redacted, api_version, event_types)
		select gen_random_uuid(), tenant_id, id, 1, '\x01', 'https://subscriber.invalid', 1, array['recording.failed'] from webhook_endpoints
		where tenant_id = (select tenant_id from recordings where id = $1)`, recordingID.Bytes())
}
