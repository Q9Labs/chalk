package postgres_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
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

func newAllocationCleanupFixture(t *testing.T, expiredLease bool, jobKind string) (pgx.Tx, transcriptionAllocationCleanupFixture) {
	t.Helper()
	return newAllocationCleanupFixtureWithMode(t, expiredLease, jobKind, "on_demand")
}

func newAllocationCleanupFixtureWithMode(t *testing.T, expiredLease bool, jobKind, mode string) (pgx.Tx, transcriptionAllocationCleanupFixture) {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx := context.Background()
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin cleanup fixture transaction: %v", err)
	}
	completed := false
	defer func() {
		if !completed {
			_ = transaction.Rollback(ctx)
		}
	}()

	newID := func(label string) utilities.ID {
		id, idErr := utilities.NewID()
		if idErr != nil {
			t.Fatalf("generate %s id: %v", label, idErr)
		}
		return id
	}
	tenantID := newID("tenant")
	spaceID := newID("space")
	episodeID := newID("episode")
	recordingID := newID("recording")
	reservationID := newID("reservation")
	jobID := newID("job")
	claimID := newID("claim")
	presentationID := newID("presentation")
	inputID := newID("input")
	keyHandle := newID("key handle")
	objectHandle := newID("object handle")
	digest := sha256.Sum256([]byte("transcription allocation cleanup fixture"))
	now := time.Now().UTC()
	leaseExpiresAt := now.Add(time.Hour)
	if expiredLease {
		leaseExpiresAt = now.Add(-time.Minute)
	}
	leaseToken := "transcription-allocation-cleanup-lease"
	leaseOwner := "transcription-allocation-cleanup-worker"
	envelopeBytes := "fixture-envelope"
	if jobKind == "capture" {
		envelopeBytes = `{"completion_only":false}`
	}

	execCleanupFixture(t, transaction, `insert into tenants (id, name) values ($1, $2)`, tenantID.Bytes(), "transcription allocation cleanup")
	execCleanupFixture(t, transaction, `insert into spaces (id, name, tenant_id, slug, media_plane) values ($1, $2, $3, $4, 'cf_sfu')`, spaceID.Bytes(), "transcription allocation cleanup", tenantID.Bytes(), "transcription-allocation-cleanup-"+spaceID.String()[:8])
	execCleanupFixture(t, transaction, `
		insert into episodes (id, status, space_id, tenant_id, config_snapshot)
		values ($1, 'active', $2, $3, $4::jsonb)`,
		episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes(), fmt.Sprintf(`{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0,"artifact_policy":{"schema_version":"episode_config.v2","recording":{"mode":"manual","profile":"composite_720p_v1","retention_seconds":86400},"transcription":{"mode":%q,"retention_seconds":0,"source_window_seconds":3600,"provider_policy_version":"cleanup"}}}`, mode))
	execCleanupFixture(t, transaction, `
		insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider)
		values ($1, $2, $3, $4, 'completed', 'r2')`, recordingID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes())
	execCleanupFixture(t, transaction, `
		insert into recording_reservations (
			id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
			request_fingerprint, policy_snapshot_version, participant_count,
			max_duration_seconds, input_bitrate_bps, state, ends_at
		) values ($1, $2, $3, $4, $5, $6, $7, 'episode_config.v2', 1, 3600, 1000, 'reserved', now() + interval '1 hour')`,
		reservationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), "transcription-allocation-cleanup-"+reservationID.String(), digest[:])
	execCleanupFixture(t, transaction, `
		insert into recording_pipelines (recording_id, tenant_id, reservation_id, capture_epoch, state, capture_completed_at)
		values ($1, $2, $3, 1, 'capture_complete', now())`, recordingID.Bytes(), tenantID.Bytes(), reservationID.Bytes())
	execCleanupFixture(t, transaction, `
		insert into recording_jobs (
			id, tenant_id, episode_id, recording_id, kind, idempotency_key,
			payload_schema_version, state, available_at, attempt_count, attempt_limit,
			lease_token, lease_owner, lease_expires_at, fencing_generation
		) values ($1, $2, $3, $4, $9, $5, 1, 'leased', now(), 1, 3, $6, $7, $8, 1)`,
		jobID.Bytes(), tenantID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), "transcription-allocation-cleanup-job-"+jobID.String(), leaseToken, leaseOwner, leaseExpiresAt, jobKind)
	execCleanupFixture(t, transaction, `
		insert into recording_job_attempt_authorities (
			job_id, attempt_count, fencing_generation, capture_epoch, claim_request_id, kind,
			lease_owner, lease_token, lease_expires_at, envelope_bytes, envelope_digest
		) values ($1, 1, 1, 1, $2, $7, $3, $4, $5, $8, $6)`,
		jobID.Bytes(), claimID.Bytes(), leaseOwner, leaseToken, leaseExpiresAt, digest[:], jobKind, envelopeBytes)
	execCleanupFixture(t, transaction, `
		insert into recording_presentation_baselines (
			presentation_handle, tenant_id, space_id, episode_id, recording_id,
			schema_version, profile_version, profile, space_name,
			episode_control_revision, episode_folded_state, participant_facts,
			chat_head_sequence, baseline_at
		) values ($1, $2, $3, $4, $5, 'recording_presentation.v1', 'profile.v1',
			'{"version":"profile.v1"}'::jsonb, 'transcription allocation cleanup', 0,
			'{}'::jsonb, '[]'::jsonb, 0, now())`,
		presentationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes())
	execCleanupFixture(t, transaction, `
		insert into recording_presentation_sources (
			presentation_handle, tenant_id, space_id, episode_id, recording_id, capture_epoch,
			capture_ready_at, episode_control_start_revision, episode_control_events,
			episode_control_end_revision, participant_facts, chat_start_sequence,
			initial_chat_messages, whiteboard_start_revision, whiteboard_events,
			whiteboard_end_revision, capture_plan_start_revision
		) values ($1, $2, $3, $4, $5, 1, now(), 0, '[]'::jsonb, 0, '[]'::jsonb,
			0, '[]'::jsonb, 0, '[]'::jsonb, 0, 0)`,
		presentationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes())
	execCleanupFixture(t, transaction, `
		insert into recording_presentations (
			presentation_handle, tenant_id, space_id, episode_id, recording_id, capture_epoch,
			schema_version, profile_version, duration_millis, presentation_sha256,
			presentation_object_key, presentation_object_version, presentation_object_etag,
			presentation_content_type, presentation_byte_size, asset_manifest_object_key,
			asset_manifest_object_version, asset_manifest_object_etag, asset_manifest_content_type,
			asset_manifest_byte_size, asset_manifest_sha256, frozen_at
		) values ($1, $2, $3, $4, $5, 1, 'recording_presentation.v1', 'profile.v1', 1000,
			$6, 'fixtures/presentation.json', 'version', 'etag', 'application/json', 1,
			'fixtures/assets.json', 'version', 'etag', 'application/json', 1, $6, now())`,
		presentationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), digest[:])
	execCleanupFixture(t, transaction, `
		insert into recording_render_inputs (
			render_input_handle, tenant_id, space_id, episode_id, recording_id, render_job_id,
			attempt_count, fencing_generation, capture_epoch, envelope_digest, key_handle,
			object_handle, presentation_handle, presentation_schema_version,
			presentation_profile_version, presentation_sha256, presentation_duration_millis,
			capture_ready_at
		) values ($1, $2, $3, $4, $5, $6, 1, 1, 1, $7, $8, $9, $10,
			'recording_presentation.v1', 'profile.v1', $7, 1000, now())`,
		inputID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), jobID.Bytes(), digest[:], keyHandle.Bytes(), objectHandle.Bytes(), presentationID.Bytes())

	orphanAllocated := "fixtures/" + recordingID.String() + "/allocated.flac"
	orphanCommitted := "fixtures/" + recordingID.String() + "/committed.flac"
	sourceKey := "fixtures/" + recordingID.String() + "/source.json"
	insertTranscriptionAllocation(t, transaction, newID("allocated allocation"), newID("allocated reservation"), 1, tenantID, episodeID, recordingID, jobID, inputID, objectHandle, digest[:], "transcription_audio", "allocated", orphanAllocated)
	insertTranscriptionAllocation(t, transaction, newID("committed allocation"), newID("committed reservation"), 2, tenantID, episodeID, recordingID, jobID, inputID, objectHandle, digest[:], "transcription_audio", "committed", orphanCommitted)
	sourceAllocationID := newID("source allocation")
	insertTranscriptionAllocation(t, transaction, sourceAllocationID, newID("source reservation"), 3, tenantID, episodeID, recordingID, jobID, inputID, objectHandle, digest[:], "transcription_manifest", "committed", sourceKey)
	execCleanupFixture(t, transaction, `
		insert into recording_transcription_sources (
			recording_id, tenant_id, manifest_key, manifest_sha256, manifest_size,
			manifest_content_type, schema_version, committed_at, generation, commit_digest,
			presentation_sha256, manifest_allocation_id, manifest_object_version,
			manifest_etag, status, expires_at
		) values ($1, $2, $3, $4, 1, 'application/json', 1, now(), 1, $4, $4,
			$5, 'version', 'etag', 'ready', now() + interval '1 hour')`,
		recordingID.Bytes(), tenantID.Bytes(), sourceKey, digest[:], sourceAllocationID.Bytes())
	execCleanupFixture(t, transaction, `
		insert into recording_transcription_preparation_commits (
			transcription_job_id, tenant_id, recording_id, attempt_count, fencing_generation,
			capture_epoch, render_input_handle, commit_digest, presentation_sha256,
			duration_millis, transcription_source_id
		) values ($1, $2, $3, 1, 1, 1, $4, $5, $5, 1000, $3)`,
		jobID.Bytes(), tenantID.Bytes(), recordingID.Bytes(), inputID.Bytes(), digest[:])

	completed = true
	return transaction, transcriptionAllocationCleanupFixture{
		recordingID: recordingID, jobID: jobID, captureEpoch: 1, digest: digest[:], leaseToken: leaseToken, leaseOwner: leaseOwner,
		orphanKeys: []string{orphanAllocated, orphanCommitted}, sourceKey: sourceKey,
	}
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
