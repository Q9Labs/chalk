package postgres_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingPipelinePostgresCASAndReplay(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		url = config.DefaultDatabaseURL
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	if _, err := pool.Exec(ctx, `update recording_capacity set reserved_meetings = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0 where id = 1`); err != nil {
		t.Fatalf("reset recorder capacity fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into recording_pool_health (role, admission_open, ready_capacity, reason, observed_at) values ('capture', true, 1, 'integration fixture', now()), ('render', true, 1, 'integration fixture', now()) on conflict (role) do update set admission_open = true, ready_capacity = 1, reason = excluded.reason, observed_at = excluded.observed_at`); err != nil {
		t.Fatalf("seed recorder pool health: %v", err)
	}

	tenantID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be001")
	roomID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be002")
	sessionID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be003")
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, 'recorder integration') on conflict do nothing`, tenantID.Bytes()); err != nil {
		t.Fatalf("seed tenant fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, name, tenant_id, status, slug, media_plane) values ($1, 'recorder integration', $2, 'active', 'recorder-integration', 'cf_sfu') on conflict do nothing`, roomID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed room fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into room_sessions (id, status, room_id, tenant_id) values ($1, 'active', $2, $3) on conflict do nothing`, sessionID.Bytes(), roomID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed recorder fixture: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(ctx, `delete from recording_artifacts where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_bundles where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_jobs where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_pipelines where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_reservations where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recordings where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from room_sessions where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from rooms where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from tenants where id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `update recording_capacity set reserved_meetings = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0 where id = 1`)
	}()

	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	input := recordingpipeline.ReservationInput{
		TenantID: tenantID, RoomID: roomID, SessionID: sessionID,
		IdempotencyKey: "recorder-integration-1", ParticipantCount: 3,
		MaxDuration: time.Hour, InputBitrateBPS: 3_000_000,
	}
	reservation, err := repository.Reserve(ctx, input, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be004"))
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if reservation.State != recordingpipeline.ReservationStateReserved {
		t.Fatalf("reservation state = %s", reservation.State)
	}

	replay, err := repository.Reserve(ctx, input, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be005"))
	if err != nil {
		t.Fatalf("idempotent reserve replay: %v", err)
	}
	if replay.ID != reservation.ID {
		t.Fatalf("replay id = %s, want %s", replay.ID, reservation.ID)
	}
	input.ParticipantCount = 4
	if _, err := repository.Reserve(ctx, input, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be006")); !errors.Is(err, recordingpipeline.ErrReservationConflict) {
		t.Fatalf("conflict error = %v, want %v", err, recordingpipeline.ErrReservationConflict)
	}

	job, err := repository.Claim(ctx, recordingpipeline.ClaimInput{Kind: recordingpipeline.JobKindCapture, Owner: "capture-test", LeaseToken: "lease-capture", LeaseFor: time.Minute})
	if err != nil {
		t.Fatalf("claim capture: %v", err)
	}
	stale := recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration - 1, LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: time.Minute}
	if _, err := repository.Heartbeat(ctx, stale); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("stale heartbeat error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
	}

	bundle, err := repository.InsertBundle(ctx, recordingpipeline.BundleInput{
		ID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be007"), TenantID: tenantID, RecordingID: reservation.RecordingID,
		CaptureJobID: job.ID, SequenceNumber: 0, FencingGeneration: job.FencingGeneration,
		AttemptCount: job.AttemptCount, LeaseToken: "lease-capture", LeaseOwner: "capture-test",
		ObjectKey: "temporary/bundle-0", ContentType: "video/webm", Codec: "opus", ByteSize: 32,
		Checksum: []byte("0123456789abcdef"), MonotonicStartMillis: 0, MonotonicEndMillis: 1000,
		MediaStartMillis: 0, MediaEndMillis: 1000,
	})
	if err != nil {
		t.Fatalf("insert bundle: %v", err)
	}
	if bundle.SequenceNumber != 0 {
		t.Fatalf("bundle sequence = %d", bundle.SequenceNumber)
	}
	if _, err := repository.CompleteCapture(ctx, recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration, LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: time.Minute}, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be008")); err != nil {
		t.Fatalf("complete capture: %v", err)
	}
	render, err := repository.Claim(ctx, recordingpipeline.ClaimInput{Kind: recordingpipeline.JobKindRender, Owner: "render-test", LeaseToken: "lease-render", LeaseFor: time.Minute})
	if err != nil {
		t.Fatalf("claim render: %v", err)
	}
	artifactInput := recordingpipeline.ArtifactInput{
		TenantID: tenantID, RecordingID: reservation.RecordingID, RenderJobID: render.ID,
		ObjectKey: "recordings/final.mp4", ContentType: "video/mp4", ByteSize: 64,
		Checksum: []byte("0123456789abcdef"), Duration: time.Second,
		AttemptCount: render.AttemptCount, FencingGeneration: render.FencingGeneration,
		LeaseToken: "lease-render", LeaseOwner: "render-test",
	}
	artifact, err := repository.CommitArtifact(ctx, artifactInput)
	if err != nil {
		t.Fatalf("commit artifact: %v", err)
	}
	if _, err := repository.CommitArtifact(ctx, artifactInput); err != nil {
		t.Fatalf("artifact replay: %v", err)
	}
	artifactInput.ByteSize++
	if _, err := repository.CommitArtifact(ctx, artifactInput); !errors.Is(err, recordingpipeline.ErrArtifactConflict) {
		t.Fatalf("artifact mismatch error = %v, want %v", err, recordingpipeline.ErrArtifactConflict)
	}
	if artifact.ObjectKey != "recordings/final.mp4" {
		t.Fatalf("artifact key = %s", artifact.ObjectKey)
	}
	if _, err := pool.Exec(ctx, `update recording_artifacts set object_key = 'tampered' where recording_id = $1`, reservation.RecordingID.Bytes()); err == nil {
		t.Fatal("immutable artifact update unexpectedly succeeded")
	}
	recoverInput := recordingpipeline.ReservationInput{
		TenantID: tenantID, RoomID: roomID, SessionID: sessionID,
		IdempotencyKey: "recorder-integration-recovery", ParticipantCount: 1,
		MaxDuration: time.Hour, InputBitrateBPS: 1_000_000,
	}
	recoverReservation, err := repository.Reserve(ctx, recoverInput, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be00a"))
	if err != nil {
		t.Fatalf("reserve recovery: %v", err)
	}
	var recoveryJobState, recoveryPipelineState string
	var recoveryAvailableAt time.Time
	if err := pool.QueryRow(ctx, `select recording_jobs.state, recording_pipelines.state, recording_jobs.available_at from recording_jobs join recording_pipelines using (recording_id) where recording_jobs.recording_id = $1 and recording_jobs.kind = 'capture'`, recoverReservation.RecordingID.Bytes()).Scan(&recoveryJobState, &recoveryPipelineState, &recoveryAvailableAt); err != nil {
		t.Fatalf("inspect recovery work: %v", err)
	}
	if recoveryJobState != "pending" || recoveryPipelineState != "reserved" || recoveryAvailableAt.After(time.Now()) {
		t.Fatalf("recovery work is not claimable: job=%s pipeline=%s available_at=%s", recoveryJobState, recoveryPipelineState, recoveryAvailableAt)
	}
	recoverJob, err := repository.Claim(ctx, recordingpipeline.ClaimInput{Kind: recordingpipeline.JobKindCapture, Owner: "recovery-test", LeaseToken: "lease-recovery", LeaseFor: time.Minute})
	if err != nil {
		_ = pool.QueryRow(ctx, `select recording_jobs.state, recording_pipelines.state from recording_jobs join recording_pipelines using (recording_id) where recording_jobs.recording_id = $1 and recording_jobs.kind = 'capture'`, recoverReservation.RecordingID.Bytes()).Scan(&recoveryJobState, &recoveryPipelineState)
		t.Fatalf("claim recovery job: %v (job=%s pipeline=%s)", err, recoveryJobState, recoveryPipelineState)
	}
	if _, err := pool.Exec(ctx, `update recording_jobs set lease_expires_at = now() - interval '1 second' where id = $1`, recoverJob.ID.Bytes()); err != nil {
		t.Fatalf("expire recovery lease: %v", err)
	}
	recovered, err := repository.RecoverExpired(ctx)
	if err != nil {
		t.Fatalf("recover expired job: %v", err)
	}
	if len(recovered) != 1 || recovered[0].State != recordingpipeline.JobStatePending {
		t.Fatalf("recovered jobs = %+v", recovered)
	}
	recoverPipeline, err := repository.GetPipeline(ctx, tenantID, recoverReservation.RecordingID)
	if err != nil {
		t.Fatalf("get recovered pipeline: %v", err)
	}
	if recoverPipeline.State != recordingpipeline.StateRetryableFailure {
		t.Fatalf("recovered pipeline state = %s", recoverPipeline.State)
	}
	if _, err := pool.Exec(ctx, `update recording_reservations set created_at = now() - interval '11 minutes' where id = $1`, recoverReservation.ID.Bytes()); err != nil {
		t.Fatalf("expire recovery reservation: %v", err)
	}
	var reservedParticipants int
	if err := pool.QueryRow(ctx, `select reserved_participants from recording_capacity where id = 1`).Scan(&reservedParticipants); err != nil {
		t.Fatalf("read capacity: %v", err)
	}
	if reservedParticipants != 1 {
		t.Fatalf("reserved participants after capture completion = %d, want 1 for retryable recovery reservation", reservedParticipants)
	}
	noShowInput := recordingpipeline.ReservationInput{
		TenantID: tenantID, RoomID: roomID, SessionID: sessionID,
		IdempotencyKey: "recorder-integration-no-show", ParticipantCount: 2,
		MaxDuration: time.Hour, InputBitrateBPS: 2_000_000,
	}
	noShow, err := repository.Reserve(ctx, noShowInput, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be009"))
	if err != nil {
		t.Fatalf("reserve no-show: %v", err)
	}
	if _, err := pool.Exec(ctx, `update recording_reservations set created_at = now() - interval '11 minutes' where id = $1`, noShow.ID.Bytes()); err != nil {
		t.Fatalf("expire no-show fixture: %v", err)
	}
	expired, err := repository.ExpireReservations(ctx, time.Now().UTC())
	if err != nil {
		t.Fatalf("expire reservations: %v", err)
	}
	if len(expired) != 1 || expired[0].State != recordingpipeline.ReservationStateExpired || expired[0].ID != noShow.ID {
		t.Fatalf("expired reservations = %+v", expired)
	}
	if err := pool.QueryRow(ctx, `select reserved_participants from recording_capacity where id = 1`).Scan(&reservedParticipants); err != nil {
		t.Fatalf("read capacity after no-show: %v", err)
	}
	if reservedParticipants != 1 {
		t.Fatalf("reserved participants after no-show expiry = %d, want 1 retained for retry", reservedParticipants)
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
