package postgres_test

import (
	"crypto/sha256"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
