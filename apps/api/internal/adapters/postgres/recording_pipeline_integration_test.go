package postgres_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
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
	if err := resetRecordingCaptureSignaling(ctx, pool); err != nil {
		t.Fatalf("reset capture signaling: %v", err)
	}
	if err := resetRecordingCapturePlans(ctx, pool); err != nil {
		t.Fatalf("reset capture plans: %v", err)
	}
	if err := resetRecordingJobAuthorities(ctx, pool); err != nil {
		t.Fatalf("reset recorder authorities: %v", err)
	}
	_, _ = pool.Exec(ctx, `delete from recording_artifacts where tenant_id = '6a9b6a12-7457-4fe9-a58b-8b234d0be001'`)
	_, _ = pool.Exec(ctx, `delete from recording_bundles where tenant_id = '6a9b6a12-7457-4fe9-a58b-8b234d0be001'`)
	_, _ = pool.Exec(ctx, `delete from recording_jobs where tenant_id = '6a9b6a12-7457-4fe9-a58b-8b234d0be001'`)
	_, _ = pool.Exec(ctx, `delete from recording_pipelines where tenant_id = '6a9b6a12-7457-4fe9-a58b-8b234d0be001'`)
	_, _ = pool.Exec(ctx, `delete from recording_reservations where tenant_id = '6a9b6a12-7457-4fe9-a58b-8b234d0be001'`)
	_, _ = pool.Exec(ctx, `delete from recordings where tenant_id = '6a9b6a12-7457-4fe9-a58b-8b234d0be001'`)
	_, _ = pool.Exec(ctx, `delete from episodes where tenant_id = '6a9b6a12-7457-4fe9-a58b-8b234d0be001'`)
	_, _ = pool.Exec(ctx, `delete from spaces where tenant_id = '6a9b6a12-7457-4fe9-a58b-8b234d0be001'`)
	if _, err := pool.Exec(ctx, `insert into recording_capacity (id, reserved_episodes, reserved_participants, reserved_input_bitrate_bps) values (1, 0, 0, 0) on conflict (id) do update set reserved_episodes = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0, updated_at = now()`); err != nil {
		t.Fatalf("reset recorder capacity fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into recording_pool_health (role, admission_open, ready_capacity, reason, observed_at) values ('capture', true, 1, 'integration fixture', now()), ('render', true, 1, 'integration fixture', now()) on conflict (role) do update set admission_open = true, ready_capacity = 1, reason = excluded.reason, observed_at = excluded.observed_at`); err != nil {
		t.Fatalf("seed recorder pool health: %v", err)
	}

	tenantID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be001")
	mismatchedTenantID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be00c")
	spaceID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be002")
	episodeID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be003")
	otherEpisodeID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be00d")
	participantID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be00e")
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, 'recorder integration') on conflict do nothing`, tenantID.Bytes()); err != nil {
		t.Fatalf("seed tenant fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, 'recorder integration mismatch') on conflict do nothing`, mismatchedTenantID.Bytes()); err != nil {
		t.Fatalf("seed mismatched tenant fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, name, tenant_id, slug, media_plane) values ($1, 'recorder integration', $2, 'recorder-integration', 'cf_sfu') on conflict do nothing`, spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed space fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot) values ($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}'::jsonb) on conflict do nothing`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed recorder fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot) values ($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}'::jsonb) on conflict do nothing`, otherEpisodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed alternate Episode fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into participants (id, name, capabilities, tenant_id, space_id, episode_id, generation, status, role, joined_at) values ($1, 'Capture Participant', array['subscribe'], $2, $3, $4, 7, 'active', 'collaborator', now()) on conflict do nothing`, participantID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()); err != nil {
		t.Fatalf("seed capture participant: %v", err)
	}
	foldedState := `{"control_revision":4,"status":"active","participants":[{"participant_id":"` + participantID.String() + `","display_name":"Capture Participant","admission_revision":4}]}`
	if _, err := pool.Exec(ctx, `insert into sync_episode_control (tenant_id, space_id, episode_id, control_revision, folded_state, state_schema_version, state_digest, snapshot_bytes) values ($1, $2, $3, 4, $4::text::jsonb, 1, decode(repeat('00', 32), 'hex'), octet_length($4::text)) on conflict (tenant_id, episode_id) do update set control_revision = excluded.control_revision, folded_state = excluded.folded_state, state_schema_version = excluded.state_schema_version, state_digest = excluded.state_digest, snapshot_bytes = excluded.snapshot_bytes`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), foldedState); err != nil {
		t.Fatalf("seed capture folded state: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(ctx, `delete from recording_artifacts where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_bundles where tenant_id = $1`, tenantID.Bytes())
		if err := resetRecordingCaptureSignaling(ctx, pool); err != nil {
			t.Errorf("clean capture signaling: %v", err)
		}
		if err := resetRecordingCapturePlans(ctx, pool); err != nil {
			t.Errorf("clean capture plans: %v", err)
		}
		if err := resetRecordingJobAuthorities(ctx, pool); err != nil {
			t.Errorf("clean recorder authorities: %v", err)
		}
		_, _ = pool.Exec(ctx, `delete from recording_jobs where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_pipelines where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_reservations where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recordings where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from provider_operation_observations where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from provider_operation_observation_heads where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from sync_episode_control where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from participants where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from episodes where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from spaces where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from tenants where id = $1`, mismatchedTenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from tenants where id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `update recording_capacity set reserved_episodes = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0 where id = 1`)
	}()

	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	input := recordingpipeline.ReservationInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		RecordingID:    mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be00b"),
		IdempotencyKey: "recorder-integration-1", ParticipantCount: 3,
		PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
		MaxDuration:           time.Hour, InputBitrateBPS: 3_000_000,
	}
	reservation, err := repository.Reserve(ctx, input, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be004"))
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if reservation.State != recordingpipeline.ReservationStateReserved {
		t.Fatalf("reservation state = %s", reservation.State)
	}
	if reservation.PolicySnapshotVersion != recordingpipeline.SupportedPolicySnapshotVersion {
		t.Fatalf("reservation policy snapshot version = %q", reservation.PolicySnapshotVersion)
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

	claimRequestID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be010")
	claimed := make(chan struct{})
	releaseClaim := make(chan struct{})
	var blockOnce sync.Once
	concurrentRepository := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(
		sqlc.New(pool),
		pool,
		func(queries sqlc.Querier) sqlc.Querier {
			return blockingRecordingClaimQuerier{Querier: queries, claimed: claimed, release: releaseClaim, once: &blockOnce}
		},
	)
	type claimResult struct {
		job recordingpipeline.Job
		err error
	}
	firstResult := make(chan claimResult, 1)
	go func() {
		job, claimErr := concurrentRepository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: claimRequestID, Kind: recordingpipeline.JobKindCapture, Owner: "capture-test", LeaseToken: "lease-capture", LeaseFor: time.Minute})
		firstResult <- claimResult{job: job, err: claimErr}
	}()
	select {
	case <-claimed:
	case result := <-firstResult:
		t.Fatalf("first concurrent claim returned before its transaction fence: %v", result.err)
	}
	secondStarted := make(chan struct{})
	secondResult := make(chan claimResult, 1)
	go func() {
		close(secondStarted)
		job, claimErr := concurrentRepository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: claimRequestID, Kind: recordingpipeline.JobKindCapture, Owner: "capture-test", LeaseToken: "different-lease", LeaseFor: 5 * time.Minute})
		secondResult <- claimResult{job: job, err: claimErr}
	}()
	<-secondStarted
	select {
	case result := <-secondResult:
		t.Fatalf("concurrent replay returned before the first claim committed: job=%s err=%v", result.job.ID, result.err)
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseClaim)
	first := <-firstResult
	second := <-secondResult
	if first.err != nil || second.err != nil {
		t.Fatalf("concurrent claim replay errors: first=%v second=%v", first.err, second.err)
	}
	job := first.job
	publicationRegistry := mediapublications.NewService(postgres.NewProviderOperationRepositoryWithPool(pool))
	if _, err := publicationRegistry.RecordPublishedTracks(ctx, mediapublications.RecordInput{
		TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 7,
		ConnectionID: "publisher-connection", Tracks: []mediapublications.PublishedTrack{{Source: "camera", MID: "0", TrackName: "camera-track"}},
	}); err != nil {
		t.Fatalf("record capture publication: %v", err)
	}
	capturePlanService := captureplan.NewService(postgres.NewRecordingCapturePlanRepositoryWithPool(pool))
	capturePlanInput := captureplan.NewWaitInput(captureplan.PlanAuthority{
		PlanHandle: captureplan.PlanHandle(job.Authority.Envelope.PlanHandle), TenantID: tenantID,
		SpaceID: spaceID, EpisodeID: episodeID, RecordingID: reservation.RecordingID, JobID: job.ID,
		AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration,
		CaptureEpoch: captureplane.CaptureEpoch(job.Authority.Envelope.CaptureEpoch), EnvelopeDigest: job.Authority.EnvelopeDigest,
	}, captureplan.WorkerLease{Owner: "capture-test", Token: "lease-capture", ExpiresAt: job.Authority.LeaseExpiresAt}, 0, 100*time.Millisecond)
	firstPlan, err := capturePlanService.Wait(ctx, capturePlanInput)
	if err != nil {
		t.Fatalf("wait for first capture plan: %v", err)
	}
	if firstPlan.Revision() != 1 || len(firstPlan.Tracks()) != 1 || firstPlan.Tracks()[0].OwnerReference != "publisher-connection" || firstPlan.Participants()[0].JoinOrdinal != 4 {
		t.Fatalf("first capture plan = revision %d participants %#v tracks %#v", firstPlan.Revision(), firstPlan.Participants(), firstPlan.Tracks())
	}
	renewedJob, err := repository.Heartbeat(ctx, recordingpipeline.LeaseInput{
		JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration,
		LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: 2 * time.Minute,
		CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest,
	})
	if err != nil || renewedJob.LeaseExpiresAt == nil || !renewedJob.LeaseExpiresAt.After(job.Authority.LeaseExpiresAt) {
		t.Fatalf("renew capture lease: job=%#v error=%v", renewedJob, err)
	}
	capturePlanInput.LeaseExpiresAt = *renewedJob.LeaseExpiresAt
	updatedFoldedState := `{"control_revision":5,"status":"active","participants":[{"participant_id":"` + participantID.String() + `","display_name":"Renamed Participant","admission_revision":4}]}`
	if _, err := pool.Exec(ctx, `update sync_episode_control set control_revision = 5, folded_state = $4::text::jsonb, snapshot_bytes = octet_length($4::text), updated_at = now() where tenant_id = $1 and space_id = $2 and episode_id = $3`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), updatedFoldedState); err != nil {
		t.Fatalf("advance capture folded state: %v", err)
	}
	capturePlanInput.AfterRevision = firstPlan.Revision()
	secondPlan, err := capturePlanService.Wait(ctx, capturePlanInput)
	if err != nil {
		t.Fatalf("wait for revised capture plan: %v", err)
	}
	if secondPlan.Revision() != 2 || secondPlan.Participants()[0].DisplayName != "Renamed Participant" {
		t.Fatalf("second capture plan = revision %d participants %#v", secondPlan.Revision(), secondPlan.Participants())
	}
	capturePlanInput.AfterRevision = secondPlan.Revision()
	capturePlanInput.MaxWait = 5 * time.Millisecond
	if _, err := capturePlanService.Wait(ctx, capturePlanInput); !errors.Is(err, captureplan.ErrWaitTimeout) {
		t.Fatalf("unchanged capture plan wait error = %v, want %v", err, captureplan.ErrWaitTimeout)
	}
	if _, err := pool.Exec(ctx, `update recording_capture_plans set revision = revision + 1 where plan_handle = $1`, job.Authority.Envelope.PlanHandle); err == nil {
		t.Fatal("append-only capture plan update unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `delete from recording_capture_plans where plan_handle = $1`, job.Authority.Envelope.PlanHandle); err == nil {
		t.Fatal("append-only capture plan delete unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `truncate recording_capture_plans`); err == nil {
		t.Fatal("append-only capture plan truncate unexpectedly succeeded")
	}
	planLock, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin capture plan lock: %v", err)
	}
	if _, err := planLock.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1::text, 2))`, string(capturePlanInput.PlanHandle)); err != nil {
		_ = planLock.Rollback(ctx)
		t.Fatalf("hold capture plan lock: %v", err)
	}
	planLockStarted := make(chan struct{})
	planLockOnce := &sync.Once{}
	blockedPlanRepository := postgres.NewRecordingCapturePlanRepositoryWithTransactor(pool, func(queries sqlc.Querier) sqlc.Querier {
		return capturePlanLockObserverQuerier{Querier: queries, started: planLockStarted, once: planLockOnce}
	})
	blockedPlanResult := make(chan error, 1)
	go func() {
		_, reconcileErr := blockedPlanRepository.Reconcile(ctx, capturePlanInput)
		blockedPlanResult <- reconcileErr
	}()
	<-planLockStarted
	if _, err := pool.Exec(ctx, `update recording_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`, job.ID.Bytes()); err != nil {
		_ = planLock.Rollback(ctx)
		t.Fatalf("expire capture lease behind plan lock: %v", err)
	}
	if err := planLock.Commit(ctx); err != nil {
		t.Fatalf("release capture plan lock: %v", err)
	}
	if err := <-blockedPlanResult; !errors.Is(err, captureplan.ErrPlanAuthorityMismatch) {
		t.Fatalf("post-lock expired plan lease error = %v, want %v", err, captureplan.ErrPlanAuthorityMismatch)
	}
	renewedLeaseExpiresAt := time.Now().UTC().Add(2 * time.Minute)
	if _, err := pool.Exec(ctx, `update recording_jobs set lease_expires_at = $2 where id = $1`, job.ID.Bytes(), renewedLeaseExpiresAt); err != nil {
		t.Fatalf("restore capture lease after plan lock: %v", err)
	}
	capturePlanInput.LeaseExpiresAt = renewedLeaseExpiresAt
	captureProvider := &recordingCapturePlaneFixture{}
	captureSignalingRepository := postgres.NewRecordingCaptureSignalingRepositoryWithPool(pool)
	captureSignalingService, err := capturesignaling.NewService(
		captureSignalingRepository,
		captureProvider,
		capturesignaling.Options{MaxWait: time.Second},
	)
	if err != nil {
		t.Fatalf("create capture signaling service: %v", err)
	}
	signalingAuthority := capturesignaling.CommandAuthority{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: reservation.RecordingID,
		JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration,
		CaptureEpoch: captureplane.CaptureEpoch(job.Authority.Envelope.CaptureEpoch), EnvelopeDigest: job.Authority.EnvelopeDigest,
	}
	signalingLease := capturesignaling.WorkerLease{Owner: "capture-test", Token: "lease-capture", ExpiresAt: renewedLeaseExpiresAt}
	signalingHandle, err := capturesignaling.NewSignalingHandle(job.Authority.Envelope.SignalingHandle)
	if err != nil {
		t.Fatalf("parse signaling handle: %v", err)
	}
	createCaptureCommand := capturesignaling.Command{
		SignalingHandle: signalingHandle, Authority: signalingAuthority, Lease: signalingLease,
		Identity: capturesignaling.CommandIdentity{
			Operation: captureplane.OperationCreateCaptureConnection, PlanRevision: 1, IdempotencyKey: "capture-create-1",
		},
		Input: capturesignaling.CommandInput{CreateCaptureConnection: &captureplane.CreateCaptureConnectionInput{}},
	}
	overlongLeaseCommand := createCaptureCommand
	overlongLeaseCommand.Lease.ExpiresAt = signalingLease.ExpiresAt.Add(time.Minute)
	if _, err := captureSignalingService.Execute(ctx, capturesignaling.ExecuteRequest{Command: overlongLeaseCommand}); !errors.Is(err, capturesignaling.ErrStaleAuthority) {
		t.Fatalf("lease beyond live database horizon error = %v, want %v", err, capturesignaling.ErrStaleAuthority)
	}
	createdCapture, err := captureSignalingService.Execute(ctx, capturesignaling.ExecuteRequest{Command: createCaptureCommand})
	if err != nil || createdCapture.Result.CreateCaptureConnection == nil || createdCapture.Result.CreateCaptureConnection.Negotiation.ID != "negotiation-1" {
		t.Fatalf("create capture connection execution=%#v error=%v", createdCapture, err)
	}
	wrongNegotiation := capturesignaling.Command{
		SignalingHandle: signalingHandle, Authority: signalingAuthority, Lease: signalingLease,
		Identity: capturesignaling.CommandIdentity{
			Operation: captureplane.OperationRenegotiateCaptureConnection, PlanRevision: 1, IdempotencyKey: "capture-renegotiate-wrong",
		},
		Input: capturesignaling.CommandInput{RenegotiateCaptureConnection: &captureplane.RenegotiateCaptureConnectionInput{
			Connection: "provider-capture-connection", NegotiationID: "wrong-negotiation",
			Description: captureplane.Description{Type: "answer", SDP: "v=0\r\n"},
		}},
	}
	if _, err := captureSignalingService.Execute(ctx, capturesignaling.ExecuteRequest{Command: wrongNegotiation}); !errors.Is(err, capturesignaling.ErrNegotiationMismatch) {
		t.Fatalf("wrong negotiation error = %v, want %v", err, capturesignaling.ErrNegotiationMismatch)
	}
	renegotiateCaptureCommand := wrongNegotiation
	renegotiateCaptureCommand.Identity.IdempotencyKey = "capture-renegotiate-1"
	renegotiateCaptureCommand.Input.RenegotiateCaptureConnection.NegotiationID = "negotiation-1"
	if _, err := captureSignalingService.Execute(ctx, capturesignaling.ExecuteRequest{Command: renegotiateCaptureCommand}); err != nil {
		t.Fatalf("renegotiate capture connection: %v", err)
	}
	replayedCapture, err := captureSignalingService.Execute(ctx, capturesignaling.ExecuteRequest{Command: createCaptureCommand})
	if err != nil || !replayedCapture.Replayed || captureProvider.createCalls != 1 || captureProvider.renegotiateCalls != 1 {
		t.Fatalf("capture signaling replay=%v create_calls=%d renegotiate_calls=%d error=%v", replayedCapture.Replayed, captureProvider.createCalls, captureProvider.renegotiateCalls, err)
	}
	closeCaptureCommand := capturesignaling.Command{
		SignalingHandle: signalingHandle, Authority: signalingAuthority, Lease: signalingLease,
		Identity: capturesignaling.CommandIdentity{
			Operation: captureplane.OperationCloseCaptureConnection, PlanRevision: 1, IdempotencyKey: "capture-close-not-confirmed",
		},
		Input: capturesignaling.CommandInput{CloseCaptureConnection: &captureplane.CloseCaptureConnectionInput{
			Connection: "provider-capture-connection", Force: true,
		}},
	}
	closeCapture, err := captureSignalingService.Execute(ctx, capturesignaling.ExecuteRequest{Command: closeCaptureCommand})
	if err != nil || closeCapture.Result.CloseCaptureConnection == nil || closeCapture.Result.CloseCaptureConnection.Closed {
		t.Fatalf("unconfirmed close execution=%#v error=%v", closeCapture, err)
	}
	var captureConnectionState string
	if err := pool.QueryRow(ctx, `select state from recording_capture_connections where signaling_handle = $1`, signalingHandle.String()).Scan(&captureConnectionState); err != nil {
		t.Fatalf("read unconfirmed close projection: %v", err)
	}
	if captureConnectionState != captureplane.CaptureConnectionConnecting.String() {
		t.Fatalf("unconfirmed close state = %s, want %s", captureConnectionState, captureplane.CaptureConnectionConnecting)
	}
	inspectIdentity := capturesignaling.CommandIdentity{
		Operation: captureplane.OperationInspectCaptureConnection, PlanRevision: 1, IdempotencyKey: "capture-inspect-race",
	}
	inspectMetadata := captureplane.OperationMetadata{
		Identity: captureplane.CaptureIdentity{
			TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: reservation.RecordingID,
		},
		CaptureEpoch: signalingAuthority.CaptureEpoch, PlanRevision: inspectIdentity.PlanRevision,
		IdempotencyKey: inspectIdentity.IdempotencyKey,
	}
	inspectCommand := capturesignaling.Command{
		SignalingHandle: signalingHandle, Authority: signalingAuthority, Lease: signalingLease, Identity: inspectIdentity,
		Input: capturesignaling.CommandInput{InspectCaptureConnection: &captureplane.InspectCaptureConnectionInput{
			Metadata: inspectMetadata, Connection: "provider-capture-connection",
		}},
	}
	inspectRequestBytes, inspectFingerprint, err := capturesignaling.CanonicalRequest(inspectCommand)
	if err != nil {
		t.Fatalf("canonicalize capture inspect: %v", err)
	}
	inspectKey := capturesignaling.CommandKey{
		SignalingHandle: signalingHandle, Operation: inspectIdentity.Operation,
		PlanRevision: inspectIdentity.PlanRevision, IdempotencyKey: inspectIdentity.IdempotencyKey,
	}
	if _, err := captureSignalingRepository.PrepareCommand(ctx, capturesignaling.PrepareRequest{
		Key: inspectKey, Authority: signalingAuthority, Lease: signalingLease,
		Input: inspectCommand.Input, RequestBytes: inspectRequestBytes, Fingerprint: inspectFingerprint,
	}); err != nil {
		t.Fatalf("prepare capture inspect race: %v", err)
	}
	connectionLock, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin capture connection lock: %v", err)
	}
	if _, err := connectionLock.Exec(ctx, `select signaling_handle from recording_capture_connections where signaling_handle = $1 and capture_epoch = $2 for update`, signalingHandle.String(), int64(signalingAuthority.CaptureEpoch)); err != nil {
		_ = connectionLock.Rollback(ctx)
		t.Fatalf("hold capture connection lock: %v", err)
	}
	connectionLockStarted := make(chan struct{})
	connectionLockOnce := &sync.Once{}
	blockedSignalingRepository := postgres.NewRecordingCaptureSignalingRepositoryWithTransactor(pool, func(queries sqlc.Querier) sqlc.Querier {
		return captureConnectionLockObserverQuerier{Querier: queries, started: connectionLockStarted, once: connectionLockOnce}
	})
	inspectClaim := capturesignaling.ClaimRequest{
		Key: inspectKey, Authority: signalingAuthority, Lease: signalingLease, Input: inspectCommand.Input,
		RequestBytes: inspectRequestBytes, Fingerprint: inspectFingerprint,
		Owner: signalingLease.Owner, ClaimedAt: time.Now().UTC(),
	}
	blockedClaimResult := make(chan error, 1)
	go func() {
		_, claimErr := blockedSignalingRepository.ClaimCommand(ctx, inspectClaim)
		blockedClaimResult <- claimErr
	}()
	<-connectionLockStarted
	if _, err := pool.Exec(ctx, `update recording_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`, job.ID.Bytes()); err != nil {
		_ = connectionLock.Rollback(ctx)
		t.Fatalf("expire capture lease behind connection lock: %v", err)
	}
	if err := connectionLock.Commit(ctx); err != nil {
		t.Fatalf("release capture connection lock: %v", err)
	}
	if err := <-blockedClaimResult; !errors.Is(err, capturesignaling.ErrStaleAuthority) {
		t.Fatalf("post-lock expired signaling lease error = %v, want %v", err, capturesignaling.ErrStaleAuthority)
	}
	renewedLeaseExpiresAt = time.Now().UTC().Add(2 * time.Minute)
	if _, err := pool.Exec(ctx, `update recording_jobs set lease_expires_at = $2 where id = $1`, job.ID.Bytes(), renewedLeaseExpiresAt); err != nil {
		t.Fatalf("restore capture lease after connection lock: %v", err)
	}
	signalingLease.ExpiresAt = renewedLeaseExpiresAt
	inspectClaim.Lease = signalingLease
	inspectClaim.ClaimedAt = time.Now().UTC()
	claimedInspect, err := captureSignalingRepository.ClaimCommand(ctx, inspectClaim)
	if err != nil || !claimedInspect.Claimed {
		t.Fatalf("claim capture inspect after lease restore: claim=%#v error=%v", claimedInspect, err)
	}
	leaseBeforeDispatchHeartbeat := signalingLease
	heartbeatDuringDispatch, err := repository.Heartbeat(ctx, recordingpipeline.LeaseInput{
		JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration,
		LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: 3 * time.Minute,
		CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest,
	})
	if err != nil || heartbeatDuringDispatch.LeaseExpiresAt == nil || !heartbeatDuringDispatch.LeaseExpiresAt.After(signalingLease.ExpiresAt) {
		t.Fatalf("heartbeat during capture dispatch: job=%#v error=%v", heartbeatDuringDispatch, err)
	}
	if err := captureSignalingRepository.ReleaseCommand(ctx, capturesignaling.Release{
		Key: inspectKey, Authority: signalingAuthority, Lease: leaseBeforeDispatchHeartbeat, ClaimToken: claimedInspect.ClaimToken,
	}); err != nil {
		t.Fatalf("release undispatched capture inspect after heartbeat: %v", err)
	}
	signalingLease.ExpiresAt = *heartbeatDuringDispatch.LeaseExpiresAt
	inspectClaim.Lease = signalingLease
	claimedInspect, err = captureSignalingRepository.ClaimCommand(ctx, inspectClaim)
	if err != nil || !claimedInspect.Claimed {
		t.Fatalf("reclaim released capture inspect: claim=%#v error=%v", claimedInspect, err)
	}
	if err := forceExpireRecordingCaptureClaim(ctx, pool, signalingHandle, signalingAuthority.CaptureEpoch, inspectKey); err != nil {
		t.Fatalf("expire capture inspect claim: %v", err)
	}
	ambiguousInspect, err := captureSignalingRepository.ClaimCommand(ctx, inspectClaim)
	if err != nil || !ambiguousInspect.Ambiguous {
		t.Fatalf("resolve expired capture inspect: claim=%#v error=%v", ambiguousInspect, err)
	}
	laterInspect := inspectCommand
	laterInspect.Identity.IdempotencyKey = "capture-inspect-after-ambiguous"
	laterInspect.Input.InspectCaptureConnection.Metadata.IdempotencyKey = laterInspect.Identity.IdempotencyKey
	laterRequestBytes, laterFingerprint, err := capturesignaling.CanonicalRequest(laterInspect)
	if err != nil {
		t.Fatalf("canonicalize later capture inspect: %v", err)
	}
	laterKey := inspectKey
	laterKey.IdempotencyKey = laterInspect.Identity.IdempotencyKey
	if _, err := captureSignalingRepository.PrepareCommand(ctx, capturesignaling.PrepareRequest{
		Key: laterKey, Authority: signalingAuthority, Lease: signalingLease,
		Input: laterInspect.Input, RequestBytes: laterRequestBytes, Fingerprint: laterFingerprint,
	}); err != nil {
		t.Fatalf("prepare capture command behind ambiguity: %v", err)
	}
	laterClaim, err := captureSignalingRepository.ClaimCommand(ctx, capturesignaling.ClaimRequest{
		Key: laterKey, Authority: signalingAuthority, Lease: signalingLease, Input: laterInspect.Input,
		RequestBytes: laterRequestBytes, Fingerprint: laterFingerprint,
		Owner: signalingLease.Owner, ClaimedAt: time.Now().UTC(),
	})
	if err != nil || laterClaim.Claimed || laterClaim.Ambiguous {
		t.Fatalf("claim behind ambiguous head = %#v error=%v", laterClaim, err)
	}
	conflictingBytes := []byte(`{"different":true}`)
	conflictingFingerprint := sha256.Sum256(conflictingBytes)
	if _, err := postgres.NewRecordingCaptureSignalingRepositoryWithPool(pool).PrepareCommand(ctx, capturesignaling.PrepareRequest{
		Key: replayedCapture.Key, Authority: signalingAuthority, Lease: signalingLease,
		Input: createCaptureCommand.Input, RequestBytes: conflictingBytes, Fingerprint: conflictingFingerprint,
	}); !errors.Is(err, capturesignaling.ErrConflict) {
		t.Fatalf("capture signaling conflict error = %v, want %v", err, capturesignaling.ErrConflict)
	}
	if _, err := pool.Exec(ctx, `update recording_capture_commands set request_bytes = request_bytes || decode('00', 'hex') where signaling_handle = $1`, signalingHandle.String()); err == nil {
		t.Fatal("capture command authority update unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `delete from recording_capture_commands where signaling_handle = $1`, signalingHandle.String()); err == nil {
		t.Fatal("capture command delete unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `truncate recording_capture_commands`); err == nil {
		t.Fatal("capture command truncate unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `update recording_capture_connections set tenant_id = $2 where signaling_handle = $1`, signalingHandle.String(), mismatchedTenantID.Bytes()); err == nil {
		t.Fatal("capture connection authority update unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `delete from recording_capture_connections where signaling_handle = $1`, signalingHandle.String()); err == nil {
		t.Fatal("capture connection delete unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `truncate recording_capture_connections`); err == nil {
		t.Fatal("capture connection truncate unexpectedly succeeded")
	}
	if second.job.ID != job.ID || second.job.Authority == nil || second.job.Authority.LeaseToken != "lease-capture" {
		t.Fatalf("concurrent claim replay changed authority: first=%+v second=%+v", job.Authority, second.job.Authority)
	}
	replayedJob, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be010"), Kind: recordingpipeline.JobKindCapture, Owner: "capture-test", LeaseToken: "different-lease", LeaseFor: 5 * time.Minute})
	if err != nil {
		t.Fatalf("claim replay: %v", err)
	}
	if replayedJob.ID != job.ID || replayedJob.Authority == nil || string(replayedJob.Authority.EnvelopeBytes) != string(job.Authority.EnvelopeBytes) || replayedJob.Authority.LeaseToken != "lease-capture" {
		t.Fatalf("claim replay changed authority: first=%+v replay=%+v", job.Authority, replayedJob.Authority)
	}
	if _, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be010"), Kind: recordingpipeline.JobKindCapture, Owner: "other-worker", LeaseToken: "other-lease", LeaseFor: time.Minute}); !errors.Is(err, recordingpipeline.ErrClaimConflict) {
		t.Fatalf("different worker claim error = %v, want %v", err, recordingpipeline.ErrClaimConflict)
	}
	if _, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be010"), Kind: recordingpipeline.JobKindRender, Owner: "capture-test", LeaseToken: "other-lease", LeaseFor: time.Minute}); !errors.Is(err, recordingpipeline.ErrClaimConflict) {
		t.Fatalf("different kind claim error = %v, want %v", err, recordingpipeline.ErrClaimConflict)
	}
	if _, err := pool.Exec(ctx, `update recording_job_attempt_authorities set lease_owner = 'tampered' where claim_request_id = $1`, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be010").Bytes()); err == nil {
		t.Fatal("append-only authority update unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `delete from recording_job_attempt_authorities where claim_request_id = $1`, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be010").Bytes()); err == nil {
		t.Fatal("append-only authority delete unexpectedly succeeded")
	}
	if _, err := pool.Exec(ctx, `truncate recording_job_attempt_authorities`); err == nil {
		t.Fatal("append-only authority truncate unexpectedly succeeded")
	}
	stale := recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration - 1, LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: time.Minute, CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest}
	if _, err := repository.Heartbeat(ctx, stale); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("stale heartbeat error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
	}
	tamperedDigest := append([]byte(nil), job.Authority.EnvelopeDigest...)
	tamperedDigest[0] ^= 0xff
	if _, err := repository.Heartbeat(ctx, recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration, LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: time.Minute, CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: tamperedDigest}); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("tampered digest error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
	}
	if _, err := repository.Heartbeat(ctx, recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration, LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: time.Minute, CaptureEpoch: job.Authority.Envelope.CaptureEpoch + 1, EnvelopeDigest: job.Authority.EnvelopeDigest}); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("stale epoch error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
	}

	bundle, err := repository.InsertBundle(ctx, recordingpipeline.BundleInput{
		ID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be007"), TenantID: tenantID, RecordingID: reservation.RecordingID,
		CaptureJobID: job.ID, SequenceNumber: 0, FencingGeneration: job.FencingGeneration,
		AttemptCount: job.AttemptCount, LeaseToken: "lease-capture", LeaseOwner: "capture-test",
		CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest,
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
	if _, err := repository.CompleteCapture(ctx, recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration, LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: time.Minute, CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest}, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be008")); err != nil {
		t.Fatalf("complete capture: %v", err)
	}
	render, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be011"), Kind: recordingpipeline.JobKindRender, Owner: "render-test", LeaseToken: "lease-render", LeaseFor: time.Minute})
	if err != nil {
		t.Fatalf("claim render: %v", err)
	}
	var captureCompletedAt time.Time
	if err := pool.QueryRow(ctx, `select capture_completed_at from recording_pipelines where recording_id = $1`, reservation.RecordingID.Bytes()).Scan(&captureCompletedAt); err != nil {
		t.Fatalf("read capture completion: %v", err)
	}
	expectedRenderDeadline := captureCompletedAt.UTC().Add(recordingpipeline.MaximumRenderDuration).Format(time.RFC3339Nano)
	if render.Authority == nil || render.Authority.Envelope.HardDeadline != expectedRenderDeadline {
		t.Fatalf("render hard deadline = %v, want %s", render.Authority, expectedRenderDeadline)
	}
	artifactInput := recordingpipeline.ArtifactInput{
		TenantID: tenantID, RecordingID: reservation.RecordingID, RenderJobID: render.ID,
		ObjectKey: "recordings/final.mp4", ContentType: "video/mp4", ByteSize: 64,
		Checksum: []byte("0123456789abcdef"), Duration: time.Second,
		AttemptCount: render.AttemptCount, FencingGeneration: render.FencingGeneration,
		LeaseToken: "lease-render", LeaseOwner: "render-test",
		CaptureEpoch: render.Authority.Envelope.CaptureEpoch, EnvelopeDigest: render.Authority.EnvelopeDigest,
	}
	if _, err := pool.Exec(ctx, `update recordings set tenant_id = $1 where id = $2`, mismatchedTenantID.Bytes(), reservation.RecordingID.Bytes()); err != nil {
		t.Fatalf("create mismatched public recording fixture: %v", err)
	}
	if _, err := repository.CommitArtifact(ctx, artifactInput); !errors.Is(err, recordingpipeline.ErrArtifactNotFound) {
		t.Fatalf("mismatched public recording error = %v, want %v", err, recordingpipeline.ErrArtifactNotFound)
	}
	var artifactCount int
	var jobState, pipelineState string
	if err := pool.QueryRow(ctx, `select count(*) from recording_artifacts where recording_id = $1`, reservation.RecordingID.Bytes()).Scan(&artifactCount); err != nil {
		t.Fatalf("inspect rejected artifact: %v", err)
	}
	if err := pool.QueryRow(ctx, `select recording_jobs.state, recording_pipelines.state from recording_jobs join recording_pipelines using (recording_id) where recording_jobs.id = $1`, render.ID.Bytes()).Scan(&jobState, &pipelineState); err != nil {
		t.Fatalf("inspect rejected render job: %v", err)
	}
	if artifactCount != 0 || jobState != "leased" || pipelineState != "rendering" {
		t.Fatalf("mismatched public recording mutated state: artifacts=%d job=%s pipeline=%s", artifactCount, jobState, pipelineState)
	}
	if _, err := pool.Exec(ctx, `update recordings set tenant_id = $1 where id = $2`, tenantID.Bytes(), reservation.RecordingID.Bytes()); err != nil {
		t.Fatalf("restore public recording tenant: %v", err)
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
	var recordingStatus, storageKey, contentType string
	var storageSize, durationMillis int64
	var storageChecksum []byte
	if err := pool.QueryRow(ctx, `select status, storage_key, storage_content_type, storage_size, storage_checksum, duration_millis from recordings where id = $1`, reservation.RecordingID.Bytes()).Scan(&recordingStatus, &storageKey, &contentType, &storageSize, &storageChecksum, &durationMillis); err != nil {
		t.Fatalf("inspect committed recording: %v", err)
	}
	if recordingStatus != "completed" || storageKey != artifact.ObjectKey || contentType != artifact.ContentType || storageSize != artifact.ByteSize || string(storageChecksum) != string(artifact.Checksum) || durationMillis != artifact.Duration.Milliseconds() {
		t.Fatalf("committed recording facts = status %s key %s content type %s size %d checksum %x duration %d", recordingStatus, storageKey, contentType, storageSize, storageChecksum, durationMillis)
	}
	if _, err := pool.Exec(ctx, `update recording_artifacts set object_key = 'tampered' where recording_id = $1`, reservation.RecordingID.Bytes()); err == nil {
		t.Fatal("immutable artifact update unexpectedly succeeded")
	}
	recoverInput := recordingpipeline.ReservationInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		IdempotencyKey: "recorder-integration-recovery", ParticipantCount: 1,
		PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
		MaxDuration:           time.Hour, InputBitrateBPS: 1_000_000,
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
	recoverJob, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be012"), Kind: recordingpipeline.JobKindCapture, Owner: "recovery-test", LeaseToken: "lease-recovery", LeaseFor: time.Minute})
	if err != nil {
		_ = pool.QueryRow(ctx, `select recording_jobs.state, recording_pipelines.state from recording_jobs join recording_pipelines using (recording_id) where recording_jobs.recording_id = $1 and recording_jobs.kind = 'capture'`, recoverReservation.RecordingID.Bytes()).Scan(&recoveryJobState, &recoveryPipelineState)
		t.Fatalf("claim recovery job: %v (job=%s pipeline=%s)", err, recoveryJobState, recoveryPipelineState)
	}
	if _, err := pool.Exec(ctx, `update recording_jobs set lease_expires_at = now() - interval '1 second' where id = $1`, recoverJob.ID.Bytes()); err != nil {
		t.Fatalf("expire recovery lease: %v", err)
	}
	if _, err := repository.Heartbeat(ctx, recordingpipeline.LeaseInput{JobID: recoverJob.ID, AttemptCount: recoverJob.AttemptCount, FencingGeneration: recoverJob.FencingGeneration, LeaseToken: "lease-recovery", LeaseOwner: "recovery-test", LeaseFor: time.Minute, CaptureEpoch: recoverJob.Authority.Envelope.CaptureEpoch, EnvelopeDigest: recoverJob.Authority.EnvelopeDigest}); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("expired lease heartbeat error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
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
	retryJob, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be014"), Kind: recordingpipeline.JobKindCapture, Owner: "recovery-retry-test", LeaseToken: "lease-recovery-retry", LeaseFor: time.Minute})
	if err != nil {
		t.Fatalf("claim recovery retry: %v", err)
	}
	if retryJob.Authority == nil || retryJob.Authority.Envelope.CaptureEpoch != 2 {
		t.Fatalf("retry capture epoch = %v, want 2", retryJob.Authority)
	}
	stopOperationID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be00e")
	if _, err := repository.RequestStop(ctx, tenantID, otherEpisodeID, recoverReservation.RecordingID, stopOperationID); !errors.Is(err, recordingpipeline.ErrPipelineNotFound) {
		t.Fatalf("wrong Episode stop error = %v, want %v", err, recordingpipeline.ErrPipelineNotFound)
	}
	stoppedPipeline, err := repository.RequestStop(ctx, tenantID, episodeID, recoverReservation.RecordingID, stopOperationID)
	if err != nil {
		t.Fatalf("reserve Recording stop: %v", err)
	}
	if stoppedPipeline.StopOperationID == nil || *stoppedPipeline.StopOperationID != stopOperationID {
		t.Fatalf("stopped pipeline = %#v", stoppedPipeline)
	}
	if _, err := repository.RequestStop(ctx, tenantID, episodeID, recoverReservation.RecordingID, stopOperationID); err != nil {
		t.Fatalf("replay Recording stop: %v", err)
	}
	conflictingStopID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be00f")
	if _, err := repository.RequestStop(ctx, tenantID, episodeID, recoverReservation.RecordingID, conflictingStopID); !errors.Is(err, recordingpipeline.ErrStopConflict) {
		t.Fatalf("conflicting Recording stop error = %v, want %v", err, recordingpipeline.ErrStopConflict)
	}
	if _, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be013"), Kind: recordingpipeline.JobKindCapture, Owner: "stopped-capture-test", LeaseToken: "stopped-capture-lease", LeaseFor: time.Minute}); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("stopped capture claim error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
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
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		IdempotencyKey: "recorder-integration-no-show", ParticipantCount: 2,
		PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
		MaxDuration:           time.Hour, InputBitrateBPS: 2_000_000,
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

type blockingRecordingClaimQuerier struct {
	sqlc.Querier
	claimed chan struct{}
	release <-chan struct{}
	once    *sync.Once
}

type capturePlanLockObserverQuerier struct {
	sqlc.Querier
	started chan struct{}
	once    *sync.Once
}

func (q capturePlanLockObserverQuerier) LockRecordingCapturePlanHandle(ctx context.Context, planHandle string) error {
	q.once.Do(func() { close(q.started) })
	return q.Querier.LockRecordingCapturePlanHandle(ctx, planHandle)
}

type captureConnectionLockObserverQuerier struct {
	sqlc.Querier
	started chan struct{}
	once    *sync.Once
}

func (q captureConnectionLockObserverQuerier) LockRecordingCaptureConnection(ctx context.Context, input sqlc.LockRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error) {
	q.once.Do(func() { close(q.started) })
	return q.Querier.LockRecordingCaptureConnection(ctx, input)
}

func forceExpireRecordingCaptureClaim(
	ctx context.Context,
	pool *pgxpool.Pool,
	handle capturesignaling.SignalingHandle,
	epoch captureplane.CaptureEpoch,
	key capturesignaling.CommandKey,
) error {
	transaction, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer transaction.Rollback(ctx)
	if _, err := transaction.Exec(ctx, `alter table recording_capture_commands disable trigger user`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
		update recording_capture_commands
		set execution_expires_at = clock_timestamp() - interval '1 second'
		where signaling_handle = $1 and capture_epoch = $2 and plan_revision = $3
		  and operation_kind = $4 and idempotency_key = $5
	`, handle.String(), int64(epoch), int64(key.PlanRevision), key.Operation.String(), key.IdempotencyKey); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `alter table recording_capture_commands enable trigger user`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
		update recording_capture_connections
		set active_execution_expires_at = clock_timestamp() - interval '1 second'
		where signaling_handle = $1 and capture_epoch = $2
	`, handle.String(), int64(epoch)); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

func (q blockingRecordingClaimQuerier) ClaimRecordingJob(ctx context.Context, input sqlc.ClaimRecordingJobParams) (sqlc.ClaimRecordingJobRow, error) {
	row, err := q.Querier.ClaimRecordingJob(ctx, input)
	if err == nil {
		q.once.Do(func() {
			close(q.claimed)
			<-q.release
		})
	}
	return row, err
}

func resetRecordingJobAuthorities(ctx context.Context, pool *pgxpool.Pool) error {
	transaction, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer transaction.Rollback(ctx)
	if _, err := transaction.Exec(ctx, `alter table recording_job_attempt_authorities disable trigger user`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `delete from recording_job_attempt_authorities`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `alter table recording_job_attempt_authorities enable trigger user`); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

func resetRecordingCapturePlans(ctx context.Context, pool *pgxpool.Pool) error {
	transaction, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer transaction.Rollback(ctx)
	if _, err := transaction.Exec(ctx, `alter table recording_capture_plans disable trigger user`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `truncate recording_capture_plans`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `alter table recording_capture_plans enable trigger user`); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

func resetRecordingCaptureSignaling(ctx context.Context, pool *pgxpool.Pool) error {
	transaction, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer transaction.Rollback(ctx)
	if _, err := transaction.Exec(ctx, `alter table recording_capture_commands disable trigger user`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `alter table recording_capture_connections disable trigger user`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `update recording_capture_connections set active_command_id = null, active_execution_token = null, active_execution_expires_at = null`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `delete from recording_capture_commands`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `delete from recording_capture_connections`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `alter table recording_capture_connections enable trigger user`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `alter table recording_capture_commands enable trigger user`); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `update recording_capture_provider_rate_budget set next_call_at = now(), updated_at = now() where id = 1`); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

type recordingCapturePlaneFixture struct {
	createCalls      int
	renegotiateCalls int
	closeCalls       int
}

func (p *recordingCapturePlaneFixture) CreateCaptureConnection(_ context.Context, input captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	p.createCalls++
	return captureplane.CreateCaptureConnectionResult{
		Connection: captureplane.CaptureConnection{ConnectionReference: "provider-capture-connection", CaptureEpoch: input.Metadata.CaptureEpoch, PlanRevision: input.Metadata.PlanRevision},
		Negotiation: captureplane.Negotiation{
			ID: "negotiation-1", Requirement: captureplane.NegotiationAnswerNeeded,
			Description: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"},
		},
	}, nil
}

func (p *recordingCapturePlaneFixture) PullCaptureTracks(context.Context, captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	return captureplane.PullCaptureTracksResult{}, errors.New("unexpected pull capture tracks")
}

func (p *recordingCapturePlaneFixture) RenegotiateCaptureConnection(_ context.Context, input captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	p.renegotiateCalls++
	return captureplane.RenegotiateCaptureConnectionResult{
		Connection:  captureplane.CaptureConnection{ConnectionReference: input.Connection, CaptureEpoch: input.Metadata.CaptureEpoch, PlanRevision: input.Metadata.PlanRevision},
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}, nil
}

func (p *recordingCapturePlaneFixture) InspectCaptureConnection(context.Context, captureplane.InspectCaptureConnectionInput) (captureplane.InspectCaptureConnectionResult, error) {
	return captureplane.InspectCaptureConnectionResult{}, errors.New("unexpected inspect capture connection")
}

func (p *recordingCapturePlaneFixture) CloseCaptureTracks(context.Context, captureplane.CloseCaptureTracksInput) (captureplane.CloseCaptureTracksResult, error) {
	return captureplane.CloseCaptureTracksResult{}, errors.New("unexpected close capture tracks")
}

func (p *recordingCapturePlaneFixture) CloseCaptureConnection(_ context.Context, input captureplane.CloseCaptureConnectionInput) (captureplane.CloseCaptureConnectionResult, error) {
	p.closeCalls++
	return captureplane.CloseCaptureConnectionResult{
		Connection: captureplane.CaptureConnection{
			ConnectionReference: input.Connection, CaptureEpoch: input.Metadata.CaptureEpoch, PlanRevision: input.Metadata.PlanRevision,
		},
		Closed: false,
	}, nil
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
