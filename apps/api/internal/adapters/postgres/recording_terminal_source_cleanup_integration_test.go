package postgres_test

import (
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTerminalCaptureQueuesSourceCleanup(t *testing.T) {
	for _, scenario := range []struct {
		name string
		run  func(*testing.T, pgx.Tx, transcriptionAllocationCleanupFixture)
	}{
		{"capture_attempt_failed", func(t *testing.T, tx pgx.Tx, fixture transcriptionAllocationCleanupFixture) {
			input := fixture.failureInput()
			input.ErrorCode = pgtype.Text{String: "capture_attempt_failed", Valid: true}
			job, err := sqlc.New(tx).FailRecordingJob(context.Background(), input)
			if err != nil || job.State != "terminal_failure" {
				t.Fatalf("fail Capture job: state=%s error=%v", job.State, err)
			}
		}},
		{"capture_stopped_before_completion", func(t *testing.T, tx pgx.Tx, fixture transcriptionAllocationCleanupFixture) {
			execCleanupFixture(t, tx, `update recording_jobs set state = 'pending', lease_token = null,
				lease_owner = null, lease_expires_at = null where id = $1`, fixture.jobID.Bytes())
			execCleanupFixture(t, tx, `update recording_pipelines set stop_operation_id = gen_random_uuid(),
				stop_requested_at = now() where recording_id = $1`, fixture.recordingID.Bytes())
			jobs, err := sqlc.New(tx).RecoverExpiredRecordingJobs(context.Background(), 7200)
			if err != nil || len(jobs) != 1 || jobs[0].State != "terminal_failure" || jobs[0].ErrorCode.String != "capture_stopped_before_completion" {
				t.Fatalf("recover stopped Capture: jobs=%+v error=%v", jobs, err)
			}
		}},
		{"expired_capture_lease", func(t *testing.T, tx pgx.Tx, fixture transcriptionAllocationCleanupFixture) {
			execCleanupFixture(t, tx, `update recording_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, fixture.jobID.Bytes())
			jobs, err := sqlc.New(tx).RecoverExpiredRecordingJobs(context.Background(), 7200)
			if err != nil || len(jobs) != 1 || jobs[0].State != "terminal_failure" {
				t.Fatalf("recover expired Capture lease: jobs=%+v error=%v", jobs, err)
			}
		}},
		{"capture_reservation_expired", func(t *testing.T, tx pgx.Tx, fixture transcriptionAllocationCleanupFixture) {
			execCleanupFixture(t, tx, `update recording_jobs set state = 'pending', attempt_count = 0,
				lease_token = null, lease_owner = null, lease_expires_at = null where id = $1`, fixture.jobID.Bytes())
			execCleanupFixture(t, tx, `update recording_pipelines set state = 'reserved' where recording_id = $1`, fixture.recordingID.Bytes())
			execCleanupFixture(t, tx, `update recording_reservations set starts_at = now() - interval '20 minutes' where recording_id = $1`, fixture.recordingID.Bytes())
			reservations, err := sqlc.New(tx).ExpireRecordingReservations(context.Background(), pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true})
			if err != nil || len(reservations) != 1 {
				t.Fatalf("expire Capture reservation: reservations=%+v error=%v", reservations, err)
			}
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			tx, fixture, bundleKey := newTerminalCaptureCleanupFixture(t)
			defer func() { _ = tx.Rollback(context.Background()) }()
			scenario.run(t, tx, fixture)
			firstDue := assertTerminalCaptureCleanup(t, tx, fixture.recordingID, bundleKey)
			var terminalAt time.Time
			if err := tx.QueryRow(context.Background(), `select terminal_at from recording_jobs where id = $1`, fixture.jobID.Bytes()).Scan(&terminalAt); err != nil {
				t.Fatalf("read terminal time: %v", err)
			}
			if !firstDue.Equal(terminalAt.Add(24 * time.Hour)) {
				t.Fatalf("cleanup due at %s, want terminal time %s + 24 hours", firstDue, terminalAt)
			}
			// The backfill and a replayed terminal update cannot move an existing deadline.
			execCleanupFixture(t, tx, `select recording_backfill_terminal_capture_source_cleanup()`)
			execCleanupFixture(t, tx, `update recording_jobs set state = 'terminal_failure' where id = $1`, fixture.jobID.Bytes())
			if due := assertTerminalCaptureCleanup(t, tx, fixture.recordingID, bundleKey); !due.Equal(firstDue) {
				t.Fatalf("replayed cleanup moved deadline from %s to %s", firstDue, due)
			}
		})
	}
}

func TestTerminalCaptureSourceCleanupBackfill(t *testing.T) {
	tx, fixture, bundleKey := newTerminalCaptureCleanupFixture(t)
	defer func() { _ = tx.Rollback(context.Background()) }()
	// Recreate a terminal Capture whose cleanup jobs were missing before migration.
	execCleanupFixture(t, tx, `update recording_jobs set state = 'terminal_failure', terminal_at = now() - interval '2 days',
		lease_token = null, lease_owner = null, lease_expires_at = null where id = $1`, fixture.jobID.Bytes())
	execCleanupFixture(t, tx, `delete from transcription_cleanup_jobs where recording_id = $1 and object_kind = 'recording_source'`, fixture.recordingID.Bytes())
	execCleanupFixture(t, tx, `select recording_backfill_terminal_capture_source_cleanup()`)
	firstDue := assertTerminalCaptureCleanup(t, tx, fixture.recordingID, bundleKey)
	execCleanupFixture(t, tx, `select recording_backfill_terminal_capture_source_cleanup()`)
	if due := assertTerminalCaptureCleanup(t, tx, fixture.recordingID, bundleKey); !due.Equal(firstDue) {
		t.Fatalf("backfill moved deadline from %s to %s", firstDue, due)
	}
}

func newTerminalCaptureCleanupFixture(t *testing.T) (pgx.Tx, transcriptionAllocationCleanupFixture, string) {
	t.Helper()
	tx, fixture := newAllocationCleanupFixture(t, false, "capture")
	// Reuse the Recording and presentation fixture with a leased Capture job.
	execCleanupFixture(t, tx, `update recording_jobs set attempt_limit = 1 where id = $1`, fixture.jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_pipelines set state = 'capturing_segmented' where recording_id = $1`, fixture.recordingID.Bytes())
	execCleanupFixture(t, tx, `update recording_capacity set reserved_episodes = reserved_episodes + 1,
		reserved_participants = reserved_participants + 1, reserved_input_bitrate_bps = reserved_input_bitrate_bps + 1000 where id = 1`)
	allocationID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	requestID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	objectHandle, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	key := "tenants/fixture/recordings/" + fixture.recordingID.String() + "/capture/1/bundles/0"
	digest := sha256.Sum256([]byte(key))
	execCleanupFixture(t, tx, `insert into recording_bundle_allocations (
		id, tenant_id, episode_id, recording_id, job_id, object_handle,
		reservation_request_id, allocation_version, attempt_count, fencing_generation,
		capture_epoch, envelope_digest, sequence_number, codec, monotonic_start_millis,
		monotonic_end_millis, media_start_millis, media_end_millis, object_key,
		upload_token_hash, expected_byte_size, expected_checksum, content_type,
		expires_at, encryption_context_digest, state, object_version, object_etag,
		object_checksum, manifest_digest, committed_at
	) select $1, jobs.tenant_id, jobs.episode_id, jobs.recording_id, jobs.id, $2,
		$3, 1, 1, 1, 1, $4, 0, 'opus', 0, 1000, 0, 1000, $5,
		$4, 1, $4, 'application/vnd.chalk.recording-bundle+json', now() + interval '1 hour',
		$4, 'committed', 'version', 'etag', $4, $4, now()
		from recording_jobs jobs where jobs.id = $6`, allocationID.Bytes(), objectHandle.Bytes(), requestID.Bytes(), digest[:], key, fixture.jobID.Bytes())
	allocatedKey := key + "-allocated"
	allocatedDigest := sha256.Sum256([]byte(allocatedKey))
	execCleanupFixture(t, tx, `insert into recording_bundle_allocations (
		id, tenant_id, episode_id, recording_id, job_id, object_handle,
		reservation_request_id, allocation_version, attempt_count, fencing_generation,
		capture_epoch, envelope_digest, sequence_number, codec, monotonic_start_millis,
		monotonic_end_millis, media_start_millis, media_end_millis, object_key,
		upload_token_hash, expected_byte_size, expected_checksum, content_type,
		expires_at, encryption_context_digest, state
	) select gen_random_uuid(), jobs.tenant_id, jobs.episode_id, jobs.recording_id, jobs.id,
		gen_random_uuid(), gen_random_uuid(), 2, 1, 1, 1, $1, 1, 'opus', 1000, 2000,
		1000, 2000, $2, $3, 1, $3, 'application/vnd.chalk.recording-bundle+json',
		now() + interval '1 hour', $3, 'allocated'
		from recording_jobs jobs where jobs.id = $4`, fixture.digest, allocatedKey, allocatedDigest[:], fixture.jobID.Bytes())
	return tx, fixture, key
}

func assertTerminalCaptureCleanup(t *testing.T, tx pgx.Tx, recordingID utilities.ID, bundleKey string) time.Time {
	t.Helper()
	var count int
	var dueAt time.Time
	err := tx.QueryRow(context.Background(), `select count(*), min(due_at)
		from transcription_cleanup_jobs where recording_id = $1 and object_kind = 'recording_source'
		and object_key in ($2, $3, 'fixtures/presentation.json', 'fixtures/assets.json')`, recordingID.Bytes(), bundleKey, bundleKey+"-allocated").Scan(&count, &dueAt)
	if err != nil || count != 4 {
		t.Fatalf("Capture source cleanup count=%d error=%v, want committed and allocated bundles and two presentation objects", count, err)
	}
	return dueAt
}
