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

type transcriptionAllocationCleanupFixture struct {
	recordingID  utilities.ID
	jobID        utilities.ID
	captureEpoch int64
	digest       []byte
	leaseToken   string
	leaseOwner   string
	orphanKeys   []string
	sourceKey    string
}

func (f transcriptionAllocationCleanupFixture) failureInput() sqlc.FailRecordingJobParams {
	return sqlc.FailRecordingJobParams{
		AvailableAt:       pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		ErrorCode:         pgtype.Text{String: "transcription_prepare_failed", Valid: true},
		ErrorDetail:       pgtype.Text{String: "transcription preparation failed after upload", Valid: true},
		ID:                cleanupUUID(f.jobID),
		AttemptCount:      1,
		FencingGeneration: 1,
		LeaseToken:        pgtype.Text{String: f.leaseToken, Valid: true},
		LeaseOwner:        pgtype.Text{String: f.leaseOwner, Valid: true},
		CaptureEpoch:      f.captureEpoch,
		EnvelopeDigest:    append([]byte(nil), f.digest...),
	}
}

func execCleanupFixture(t *testing.T, transaction pgx.Tx, query string, arguments ...any) {
	t.Helper()
	if _, err := transaction.Exec(context.Background(), query, arguments...); err != nil {
		t.Fatalf("seed transcription allocation cleanup fixture: %v\nquery: %s", err, query)
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

func cleanupUUID(value utilities.ID) pgtype.UUID {
	return pgtype.UUID{Bytes: value.Bytes(), Valid: true}
}

func insertTranscriptionAllocation(t *testing.T, transaction pgx.Tx, allocationID, reservationID utilities.ID, version int64, tenantID, episodeID, recordingID, jobID, inputID, objectHandle utilities.ID, digest []byte, purpose, state, objectKey string) {
	t.Helper()
	contentType := "audio/flac"
	durationMillis := any(int64(1_000))
	if purpose == "transcription_manifest" {
		contentType = "application/json"
		durationMillis = nil
	}
	checksum := sha256.Sum256([]byte(objectKey))
	if state == "committed" {
		execCleanupFixture(t, transaction, `
			insert into recording_render_object_allocations (
				id, reservation_request_id, allocation_version, tenant_id, episode_id, recording_id,
				render_job_id, render_input_handle, object_handle, attempt_count,
				fencing_generation, capture_epoch, envelope_digest, purpose, state, object_key,
				expected_content_type, expected_byte_size, expected_sha256,
				expected_duration_millis, upload_token_hash, upload_expires_at, object_version,
				object_etag, object_content_type, object_byte_size, object_sha256, committed_at
			) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, 1, $10, $11,
				'committed', $12, $13, 1, $14, $15, $16, now() + interval '1 hour',
				'version', 'etag', $13, 1, $14, now())`,
			allocationID.Bytes(), reservationID.Bytes(), version, tenantID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), jobID.Bytes(), inputID.Bytes(), objectHandle.Bytes(), digest, purpose, objectKey, contentType, checksum[:], durationMillis, checksum[:])
		return
	}
	execCleanupFixture(t, transaction, `
		insert into recording_render_object_allocations (
			id, reservation_request_id, allocation_version, tenant_id, episode_id, recording_id,
			render_job_id, render_input_handle, object_handle, attempt_count, fencing_generation,
			capture_epoch, envelope_digest, purpose, state, object_key, expected_content_type,
			expected_byte_size, expected_sha256, expected_duration_millis, upload_token_hash,
			upload_expires_at
		) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, 1, $10, $11,
			'allocated', $12, $13, 1, $14, $15, $16, now() + interval '1 hour')`,
		allocationID.Bytes(), reservationID.Bytes(), version, tenantID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), jobID.Bytes(), inputID.Bytes(), objectHandle.Bytes(), digest, purpose, objectKey, contentType, checksum[:], durationMillis, checksum[:])
}
