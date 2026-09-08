package postgres_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
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
	if err := resetRecordingPresentations(ctx, pool); err != nil {
		t.Fatalf("reset recording presentations: %v", err)
	}
	if err := cleanupRecordingSyncLifecycle(ctx, pool, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be001")); err != nil {
		t.Fatalf("reset recording Sync lifecycle: %v", err)
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
	if _, err := pool.Exec(ctx, `insert into recording_pool_health (role, admission_open, ready_capacity, reason, observed_at) values ('capture', false, 0, 'controller_unavailable', now()), ('render', false, 0, 'controller_unavailable', now()) on conflict (role) do update set admission_open = false, ready_capacity = 0, reason = excluded.reason, observed_at = excluded.observed_at`); err != nil {
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
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot) values ($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0,"artifact_policy":{"schema_version":"episode_config.v2","recording":{"mode":"manual","profile":"composite_720p_v1","retention_seconds":0},"transcription":{"mode":"on_demand","retention_seconds":0,"source_window_seconds":86400,"provider_policy_version":"integration"}}}'::jsonb) on conflict do nothing`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
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
		if err := resetRecordingPresentations(ctx, pool); err != nil {
			t.Errorf("clean recording presentations: %v", err)
		}
		_, _ = pool.Exec(ctx, `delete from recording_jobs where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_pipelines where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_reservations where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recordings where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from provider_operation_observations where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from provider_operation_observation_heads where tenant_id = $1`, tenantID.Bytes())
		if err := cleanupRecordingSyncLifecycle(ctx, pool, tenantID); err != nil {
			t.Errorf("clean recording Sync lifecycle: %v", err)
		}
		_, _ = pool.Exec(ctx, `delete from sync_episode_control where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from participants where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from episodes where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from spaces where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from tenants where id = $1`, mismatchedTenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from tenants where id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `update recording_capacity set reserved_episodes = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0 where id = 1`)
	}()

	presentationProfile, err := recordingpresentation.NewComposite720PProfile(strings.Repeat("a", sha256.Size*2))
	if err != nil {
		t.Fatalf("build recording presentation profile: %v", err)
	}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	repository, err = repository.WithRecordingPresentationProfile(presentationProfile)
	if err != nil {
		t.Fatalf("configure recording presentation profile: %v", err)
	}
	presentationObjects := newRecordingPresentationObjectStore()
	presentationFreezer, err := recordingpresentation.NewFreezer(
		postgres.NewRecordingPresentationCompletionSourceRepository(sqlc.New(pool)),
		presentationObjects,
	)
	if err != nil {
		t.Fatalf("configure recording presentation freezer: %v", err)
	}
	repository = repository.WithRecordingPresentationFreezer(presentationFreezer)
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
	demandQueries := sqlc.New(pool)
	demandObservedAt := time.Now().UTC()
	captureDemand, err := demandQueries.GetRecordingFleetDemand(ctx, sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: demandObservedAt, Valid: true}})
	if err != nil || captureDemand.DesiredNodes != 2 || captureDemand.HeldStarts != 1 || captureDemand.QueuedJobs != 1 {
		t.Fatalf("cold-start capture demand = %+v, %v", captureDemand, err)
	}
	renderDemand, err := demandQueries.GetRecordingFleetDemand(ctx, sqlc.GetRecordingFleetDemandParams{Role: "render", ObservedAt: pgtype.Timestamptz{Time: demandObservedAt, Valid: true}})
	if err != nil || renderDemand.DesiredNodes != 0 || renderDemand.QueuedJobs != 0 {
		t.Fatalf("cold-start render demand = %+v, %v", renderDemand, err)
	}
	futureStart := demandObservedAt.Add(15 * time.Minute)
	futureInput := input
	futureInput.RecordingID = mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0becd0")
	futureInput.IdempotencyKey = "recorder-integration-future"
	futureInput.StartsAt = &futureStart
	futureReservation, err := repository.Reserve(ctx, futureInput, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0becd1"))
	if err != nil {
		t.Fatalf("reserve future capture: %v", err)
	}
	notDueDemand, err := demandQueries.GetRecordingFleetDemand(ctx, sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: demandObservedAt, Valid: true}})
	if err != nil || notDueDemand.DesiredNodes != 2 || notDueDemand.ScheduledPrewarms != 0 || notDueDemand.HeldStarts != 1 || notDueDemand.QueuedJobs != 1 {
		t.Fatalf("not-due capture demand = %+v, %v", notDueDemand, err)
	}
	dueAt := futureStart.Add(-recordingpipeline.CapturePrewarm)
	dueDemand, err := demandQueries.GetRecordingFleetDemand(ctx, sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: dueAt, Valid: true}})
	if err != nil || dueDemand.DesiredNodes != 3 || dueDemand.ScheduledPrewarms != 1 || dueDemand.HeldStarts != 1 || dueDemand.QueuedJobs != 2 {
		t.Fatalf("due capture demand = %+v, %v", dueDemand, err)
	}
	if _, err := pool.Exec(ctx, `update recording_jobs set state = 'leased', attempt_count = 1, fencing_generation = 1, lease_token = 'future-lease', lease_owner = 'future-worker', lease_expires_at = $2, updated_at = now() where recording_id = $1 and kind = 'capture'`, futureReservation.RecordingID.Bytes(), futureStart); err != nil {
		t.Fatalf("lease future capture fixture: %v", err)
	}
	leasedDemand, err := demandQueries.GetRecordingFleetDemand(ctx, sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: demandObservedAt, Valid: true}})
	if err != nil || leasedDemand.DesiredNodes != 3 || leasedDemand.ScheduledPrewarms != 0 || leasedDemand.HeldStarts != 1 || leasedDemand.QueuedJobs != 1 {
		t.Fatalf("leased future capture demand = %+v, %v", leasedDemand, err)
	}
	if _, err := pool.Exec(ctx, `update recording_jobs set state = 'pending', attempt_count = 0, fencing_generation = 0, lease_token = null, lease_owner = null, lease_expires_at = null, updated_at = now() where recording_id = $1 and kind = 'capture'`, futureReservation.RecordingID.Bytes()); err != nil {
		t.Fatalf("reset future capture fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `update recording_capacity set reserved_episodes = 11 where id = 1`); err != nil {
		t.Fatalf("seed grandfathered capture capacity: %v", err)
	}
	if _, err := repository.ReleaseReservation(ctx, futureReservation.TenantID, futureReservation.ID, recordingpipeline.ReservationStateReleased); err != nil {
		t.Fatalf("release future capture fixture: %v", err)
	}
	var grandfatheredEpisodes int
	if err := pool.QueryRow(ctx, `select reserved_episodes from recording_capacity where id = 1`).Scan(&grandfatheredEpisodes); err != nil || grandfatheredEpisodes != 10 {
		t.Fatalf("grandfathered capture release capacity = %d, %v; want 10", grandfatheredEpisodes, err)
	}
	if _, err := pool.Exec(ctx, `update recording_capacity set reserved_episodes = 1 where id = 1`); err != nil {
		t.Fatalf("restore capture capacity after grandfathered release: %v", err)
	}
	// Simulate two earlier capture claims so the live claim exercises a third
	// capture epoch while retaining historical committed input.
	if _, err := pool.Exec(ctx, `update recording_pipelines set capture_epoch = 2 where recording_id = $1`, reservation.RecordingID.Bytes()); err != nil {
		t.Fatalf("seed historical capture epochs: %v", err)
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
	if _, err := pool.Exec(ctx, `update recording_capacity set reserved_episodes = 10 where id = 1`); err != nil {
		t.Fatalf("seed hard recording capacity: %v", err)
	}
	capacityInput := input
	capacityInput.ParticipantCount = 3
	capacityInput.RecordingID = mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0becf0")
	capacityInput.IdempotencyKey = "recorder-integration-capacity"
	if _, err := repository.Reserve(ctx, capacityInput, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0becf1")); !errors.Is(err, recordingpipeline.ErrRecordingCapacityUnavailable) {
		t.Fatalf("hard capacity error = %v, want %v", err, recordingpipeline.ErrRecordingCapacityUnavailable)
	}
	var reservationCount, captureJobCount int
	if err := pool.QueryRow(ctx, `select count(*) from recording_reservations where tenant_id = $1 and idempotency_key = $2`, tenantID.Bytes(), capacityInput.IdempotencyKey).Scan(&reservationCount); err != nil || reservationCount != 0 {
		t.Fatalf("reservations after hard-cap rejection = %d, %v", reservationCount, err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from recording_jobs where tenant_id = $1 and recording_id = $2 and kind = 'capture'`, tenantID.Bytes(), capacityInput.RecordingID.Bytes()).Scan(&captureJobCount); err != nil || captureJobCount != 0 {
		t.Fatalf("capture jobs after hard-cap rejection = %d, %v", captureJobCount, err)
	}
	if _, err := pool.Exec(ctx, `update recording_capacity set reserved_episodes = 1 where id = 1`); err != nil {
		t.Fatalf("restore recording capacity: %v", err)
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
	if job.Authority == nil || job.LeaseExpiresAt == nil || !job.Authority.LeaseExpiresAt.Equal(*job.LeaseExpiresAt) {
		t.Fatal("capture claim authority must use the exact persisted lease expiry")
	}
	keyAuthority := recordingkeys.Authority{
		TenantID: tenantID.String(), EpisodeID: episodeID.String(), RecordingID: reservation.RecordingID.String(), JobID: job.ID.String(),
		KeyHandle: job.Authority.Envelope.KeyHandle, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration,
		CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest,
		LeaseToken: job.Authority.LeaseToken, LeaseOwner: job.Authority.LeaseOwner, LeaseExpiresAt: job.Authority.LeaseExpiresAt,
	}
	keyContext := keyAuthority.Context("integration")
	if err := postgres.NewRecordingKeyRepository(sqlc.New(pool)).Save(ctx, recordingkeys.Record{
		Authority: keyAuthority, CiphertextBlob: []byte("encrypted-integration-capture-key"),
		EncryptionContext: keyContext, ContextDigest: keyContext.Digest(), CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("persist capture data key: %v", err)
	}
	historicalEnvelopeDigest := bytes.Repeat([]byte{0x31}, sha256.Size)
	unreferencedEnvelopeDigest := bytes.Repeat([]byte{0x32}, sha256.Size)
	historicalKeyHandle := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be031")
	unreferencedKeyHandle := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be032")
	historicalKeyAuthority := keyAuthority
	historicalKeyAuthority.KeyHandle = historicalKeyHandle.String()
	historicalKeyAuthority.CaptureEpoch = 1
	historicalKeyAuthority.EnvelopeDigest = historicalEnvelopeDigest
	historicalKeyContext := historicalKeyAuthority.Context("integration")
	unreferencedKeyAuthority := keyAuthority
	unreferencedKeyAuthority.KeyHandle = unreferencedKeyHandle.String()
	unreferencedKeyAuthority.CaptureEpoch = 2
	unreferencedKeyAuthority.EnvelopeDigest = unreferencedEnvelopeDigest
	unreferencedKeyContext := unreferencedKeyAuthority.Context("integration")
	for _, key := range []struct {
		authority recordingkeys.Authority
		context   recordingkeys.EncryptionContext
		blob      string
	}{
		{authority: historicalKeyAuthority, context: historicalKeyContext, blob: "encrypted-integration-historical-key"},
		{authority: unreferencedKeyAuthority, context: unreferencedKeyContext, blob: "encrypted-integration-unreferenced-key"},
	} {
		if _, err := pool.Exec(ctx, `
			insert into recording_data_keys (
				recording_id, capture_epoch, tenant_id, episode_id, job_id, attempt_count,
				fencing_generation, key_handle, environment, envelope_digest,
				encryption_context_digest, ciphertext_blob
			) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			reservation.RecordingID.Bytes(), key.authority.CaptureEpoch, tenantID.Bytes(), episodeID.Bytes(), job.ID.Bytes(), job.AttemptCount,
			job.FencingGeneration, mustID(t, key.authority.KeyHandle).Bytes(), key.context.Environment, key.authority.EnvelopeDigest, key.context.Digest(), []byte(key.blob),
		); err != nil {
			t.Fatalf("persist capture epoch %d fixture key: %v", key.authority.CaptureEpoch, err)
		}
	}
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
	if err != nil || renewedJob.CaptureEpoch != job.CaptureEpoch || renewedJob.LeaseExpiresAt == nil || !renewedJob.LeaseExpiresAt.After(job.Authority.LeaseExpiresAt) {
		t.Fatalf("renew capture lease: job=%#v error=%v", renewedJob, err)
	}
	t.Run("reserve bundle after heartbeat", func(t *testing.T) {
		transaction, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer transaction.Rollback(ctx)
		objects := postgres.NewRecordingObjectRepository(sqlc.New(transaction))
		input := recordingobjects.ReserveInput{
			AllocationID: "6a9b6a12-7457-4fe9-a58b-8b234d0be021", ReservationRequestID: "6a9b6a12-7457-4fe9-a58b-8b234d0be022", EncryptionContextDigest: bytes.Repeat([]byte{1}, 32),
			Authority: recordingobjects.Authority{
				TenantID: tenantID.String(), EpisodeID: episodeID.String(), RecordingID: reservation.RecordingID.String(), JobID: job.ID.String(), ObjectHandle: job.Authority.Envelope.ObjectHandle,
				AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration, CaptureEpoch: job.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest,
				LeaseOwner: "capture-test", LeaseToken: "lease-capture", LeaseExpiresAt: *renewedJob.LeaseExpiresAt,
			},
		}
		allocation, err := objects.ReserveAllocation(ctx, input)
		expectedObjectKey := fmt.Sprintf("temporary/recordings/%s/capture/%d/bundles/0/%s.bundle", reservation.RecordingID.String(), job.CaptureEpoch, input.AllocationID)
		if err != nil || allocation.ID != input.AllocationID || allocation.SequenceNumber != 0 || allocation.State != "reserved" || allocation.ObjectKey != expectedObjectKey {
			t.Fatalf("reserve actual bundle allocation: %+v, %v", allocation, err)
		}
		if err := objects.Authorize(ctx, input.Authority); err != nil {
			t.Fatalf("renewed object authority: %v", err)
		}
		expired := input.Authority
		expired.LeaseExpiresAt = time.Now().Add(-time.Second)
		if err := objects.Authorize(ctx, expired); !errors.Is(err, recordingobjects.ErrAuthorityMismatch) {
			t.Fatalf("expired object authority: %v", err)
		}
		overlong := input.Authority
		overlong.LeaseExpiresAt = overlong.LeaseExpiresAt.Add(time.Minute)
		if err := objects.Authorize(ctx, overlong); !errors.Is(err, recordingobjects.ErrAuthorityMismatch) {
			t.Fatalf("object authority beyond database horizon: %v", err)
		}
	})
	capturePlanInput.LeaseExpiresAt = *renewedJob.LeaseExpiresAt
	startOperationID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bea01")
	startFingerprint := sha256.Sum256([]byte("recording pipeline integration start"))
	if _, err := pool.Exec(ctx, `insert into sync_external_operations(tenant_id, space_id, episode_id, external_operation_id, request_key, request_fingerprint, operation_name, recording_id, payload) values($1, $2, $3, $4, 'recording_pipeline_start', $5, 'start_recording', $6, '{}'::jsonb)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), startOperationID.Bytes(), startFingerprint[:], reservation.RecordingID.Bytes()); err != nil {
		t.Fatalf("seed recording start operation: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into sync_recordings(tenant_id, space_id, episode_id, recording_id, status, generation, start_external_operation_id) values($1, $2, $3, $4, 'starting', 1, $5)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), reservation.RecordingID.Bytes(), startOperationID.Bytes()); err != nil {
		t.Fatalf("seed Sync recording: %v", err)
	}
	readyAt := time.Now().UTC().Truncate(time.Microsecond)
	lifecycleService, err := recordinglifecycle.NewService(postgres.NewRecordingLifecycleRepositoryWithPool(pool), time.Now)
	if err != nil {
		t.Fatalf("configure recording lifecycle service: %v", err)
	}
	readyInput := recordinglifecycle.ReadyInput{
		Authority: recordinglifecycle.Authority{
			TenantID: tenantID.String(), SpaceID: spaceID.String(), EpisodeID: episodeID.String(), RecordingID: reservation.RecordingID.String(), JobID: job.ID.String(),
			AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration,
			CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest,
			LeaseOwner: "capture-test", LeaseToken: "lease-capture", LeaseExpiresAt: *renewedJob.LeaseExpiresAt,
		},
		RequestKey: "capture_ready_" + reservation.RecordingID.String() + "_1", ReadyAt: readyAt,
	}
	readyPublication, err := lifecycleService.PublishReady(ctx, readyInput)
	if err != nil {
		t.Fatalf("publish recording capture ready: %v", err)
	}
	if replay, err := lifecycleService.PublishReady(ctx, readyInput); err != nil || replay.ExternalOperationID != readyPublication.ExternalOperationID {
		t.Fatalf("replay recording capture ready: publication=%#v error=%v", replay, err)
	}
	updatedFoldedState := `{"control_revision":5,"status":"active","participants":[{"participant_id":"` + participantID.String() + `","display_name":"Renamed Participant","admission_revision":4}]}`
	displayNamePayload := `{"participant_id":"` + participantID.String() + `","display_name":"Renamed Participant"}`
	if _, err := pool.Exec(ctx, `insert into sync_control_events(tenant_id, space_id, episode_id, event_id, base_revision, revision, event_name, payload, actor_participant_id, actor_generation, command_id, event_schema_version, resulting_state_digest, encoded_bytes) values($1, $2, $3, $4, 4, 5, 'participant_display_name_changed', $5::jsonb, $6, 7, 'rename_fixture_1', 1, decode(repeat('11', 32), 'hex'), octet_length($5::text))`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bea02").Bytes(), displayNamePayload, participantID.Bytes()); err != nil {
		t.Fatalf("append capture display-name event: %v", err)
	}
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
	renewedLeaseExpiresAt := time.Now().UTC().Add(2 * time.Minute).Truncate(time.Microsecond)
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
	pullCaptureCommand := capturesignaling.Command{
		SignalingHandle: signalingHandle, Authority: signalingAuthority, Lease: signalingLease,
		Identity: capturesignaling.CommandIdentity{Operation: captureplane.OperationPullCaptureTracks, PlanRevision: 1, IdempotencyKey: "capture-pull-answer"},
		Input: capturesignaling.CommandInput{PullCaptureTracks: &captureplane.PullCaptureTracksInput{
			Connection: "provider-capture-connection",
			Tracks:     []captureplane.CaptureTrack{{OwnerReference: "publisher-connection", TrackReference: "published-audio", ParticipantID: participantID, ParticipantGeneration: 1, Source: captureplane.TrackSourceMicrophone, Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}},
		}},
	}
	if _, err := captureSignalingService.Execute(ctx, capturesignaling.ExecuteRequest{Command: pullCaptureCommand}); err != nil {
		t.Fatalf("persist pull with remote answer: %v", err)
	}
	if replay, err := captureSignalingService.Execute(ctx, capturesignaling.ExecuteRequest{Command: pullCaptureCommand}); err != nil || !replay.Replayed {
		t.Fatalf("replay pull with remote answer: replay=%v error=%v", replay.Replayed, err)
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
	renewedLeaseExpiresAt = time.Now().UTC().Add(2 * time.Minute).Truncate(time.Microsecond)
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
	insertCaptureObject := func(allocationID, reservationRequestID, objectKey string, sequence, epoch int64, envelopeDigest, encryptionContextDigest []byte) {
		t.Helper()
		checksum := bytes.Repeat([]byte{byte(sequence + 0x41)}, sha256.Size)
		startMillis := sequence * 300
		endMillis := startMillis + 400
		if _, err := pool.Exec(ctx, `
			insert into recording_bundle_allocations (
				id, tenant_id, episode_id, recording_id, job_id, object_handle,
				reservation_request_id, allocation_version, attempt_count, fencing_generation,
				capture_epoch, envelope_digest, sequence_number, codec,
				monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis,
				object_key, upload_token_hash, expected_byte_size, expected_checksum, content_type,
				expires_at, encryption_context_digest, state, object_version, object_etag,
				object_checksum, manifest_digest, committed_at
			) values (
				$1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12, 'opus',
				$13, $14, $13, $14, $15, $16, 128, $17,
				'application/vnd.chalk.recording-bundle+json', $18, $19, 'committed',
				$20, $21, $17, $22, clock_timestamp()
			)`,
			mustID(t, allocationID).Bytes(), tenantID.Bytes(), episodeID.Bytes(), reservation.RecordingID.Bytes(), job.ID.Bytes(), mustID(t, job.Authority.Envelope.ObjectHandle).Bytes(),
			mustID(t, reservationRequestID).Bytes(), job.AttemptCount, job.FencingGeneration, epoch, envelopeDigest, sequence,
			startMillis, endMillis, objectKey, bytes.Repeat([]byte{byte(sequence + 0x51)}, sha256.Size), checksum,
			job.Authority.LeaseExpiresAt, encryptionContextDigest, fmt.Sprintf("capture-v%d", epoch), fmt.Sprintf("capture-etag-%d", epoch), bytes.Repeat([]byte{byte(sequence + 0x61)}, sha256.Size),
		); err != nil {
			t.Fatalf("insert committed capture epoch %d sequence %d: %v", epoch, sequence, err)
		}
	}
	insertCaptureObject("6a9b6a12-7457-4fe9-a58b-8b234d0be033", "6a9b6a12-7457-4fe9-a58b-8b234d0be035", "recordings/capture/epoch-1.bundle", 0, 1, historicalEnvelopeDigest, historicalKeyContext.Digest())
	insertCaptureObject("6a9b6a12-7457-4fe9-a58b-8b234d0be034", "6a9b6a12-7457-4fe9-a58b-8b234d0be036", "recordings/capture/epoch-3.bundle", 2, job.Authority.Envelope.CaptureEpoch, job.Authority.EnvelopeDigest, keyContext.Digest())
	completionLease := recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration, LeaseToken: "lease-capture", LeaseOwner: "capture-test", LeaseFor: time.Minute, CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest}
	completedCapture, err := repository.CompleteCapture(ctx, completionLease, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be008"))
	if err != nil || completedCapture.State != recordingpipeline.JobStateSucceeded {
		t.Fatalf("complete capture state=%s: %v", completedCapture.State, err)
	}
	// A lost response must replay without rebuilding the presentation or
	// allocating another render job. An unusable freezer proves this boundary.
	replayRepository := repository.WithRecordingPresentationFreezer(recordingpresentation.Freezer{})
	replayedCompletion, err := replayRepository.CompleteCapture(ctx, completionLease, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be098"))
	if err != nil || replayedCompletion.ID != completedCapture.ID || replayedCompletion.State != recordingpipeline.JobStateSucceeded || replayedCompletion.TerminalAt == nil || completedCapture.TerminalAt == nil || !replayedCompletion.TerminalAt.Equal(*completedCapture.TerminalAt) {
		t.Fatalf("completion replay state=%s: %v", replayedCompletion.State, err)
	}
	for _, changed := range []string{"worker", "token", "attempt", "generation", "epoch", "digest"} {
		t.Run("reject completed capture replay "+changed, func(t *testing.T) {
			stale := completionLease
			switch changed {
			case "worker":
				stale.LeaseOwner = "different-worker"
			case "token":
				stale.LeaseToken = "different-token"
			case "attempt":
				stale.AttemptCount++
			case "generation":
				stale.FencingGeneration++
			case "epoch":
				stale.CaptureEpoch++
			case "digest":
				stale.EnvelopeDigest = bytes.Repeat([]byte{0xff}, 32)
			}
			if _, err := replayRepository.CompleteCapture(ctx, stale, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be098")); err == nil {
				t.Fatal("changed completion authority accepted")
			}
		})
	}
	var renderJobs int
	if err := pool.QueryRow(ctx, `select count(*) from recording_jobs where recording_id=$1 and kind='render'`, reservation.RecordingID.Bytes()).Scan(&renderJobs); err != nil || renderJobs != 1 {
		t.Fatalf("render jobs after replay=%d: %v", renderJobs, err)
	}
	var presentationObjectKey, assetManifestObjectKey string
	var presentationDurationMillis int64
	if err := pool.QueryRow(ctx, `select presentation_object_key, asset_manifest_object_key, duration_millis from recording_presentations where tenant_id = $1 and recording_id = $2`, tenantID.Bytes(), reservation.RecordingID.Bytes()).Scan(&presentationObjectKey, &assetManifestObjectKey, &presentationDurationMillis); err != nil {
		t.Fatalf("read frozen recording presentation: %v", err)
	}
	if presentationDurationMillis != bundle.MediaEndMillis || !presentationObjects.Contains(presentationObjectKey) || !presentationObjects.Contains(assetManifestObjectKey) {
		t.Fatalf("frozen recording presentation duration=%d timeline=%q manifest=%q", presentationDurationMillis, presentationObjectKey, assetManifestObjectKey)
	}
	render, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be011"), Kind: recordingpipeline.JobKindRender, Owner: "render-test", LeaseToken: "lease-render", LeaseFor: 5 * time.Minute})
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
	renderInputHandle := mustID(t, render.Authority.Envelope.RenderInputHandle)
	renderKeyHandle := mustID(t, render.Authority.Envelope.KeyHandle)
	renderObjectHandle := mustID(t, render.Authority.Envelope.ObjectHandle)
	presentationDigest, err := hex.DecodeString(render.Authority.Envelope.PresentationSHA256)
	if err != nil || len(presentationDigest) != sha256.Size {
		t.Fatalf("decode render presentation digest: %v", err)
	}
	renderAuthority := recordingrender.Authority{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: reservation.RecordingID, JobID: render.ID,
		RenderInputHandle: renderInputHandle, KeyHandle: renderKeyHandle, ObjectHandle: renderObjectHandle,
		AttemptCount: render.AttemptCount, FencingGeneration: render.FencingGeneration, CaptureEpoch: render.Authority.Envelope.CaptureEpoch,
		EnvelopeDigest: render.Authority.EnvelopeDigest, LeaseToken: render.Authority.LeaseToken,
		LeaseOwner: render.Authority.LeaseOwner, LeaseExpiresAt: render.Authority.LeaseExpiresAt,
	}
	originalRenderAuthority := renderAuthority
	renewedRender, err := repository.Heartbeat(ctx, recordingpipeline.LeaseInput{
		JobID: render.ID, AttemptCount: render.AttemptCount, FencingGeneration: render.FencingGeneration,
		LeaseToken: render.Authority.LeaseToken, LeaseOwner: render.Authority.LeaseOwner,
		CaptureEpoch: render.Authority.Envelope.CaptureEpoch, EnvelopeDigest: render.Authority.EnvelopeDigest,
		LeaseFor: recordingpipeline.MaximumRenderDuration + time.Hour,
	})
	if err != nil || renewedRender.LeaseExpiresAt == nil || !renewedRender.LeaseExpiresAt.Equal(captureCompletedAt.Add(recordingpipeline.MaximumRenderDuration)) {
		t.Fatalf("render heartbeat must stop at immutable deadline: expiry=%v err=%v", renewedRender.LeaseExpiresAt, err)
	}
	renderAuthority.LeaseExpiresAt = *renewedRender.LeaseExpiresAt
	renderRepository := postgres.NewRecordingRenderRepositoryWithPool(pool, false)
	storedRenderInput, err := renderRepository.ResolveInput(ctx, renderAuthority)
	if err != nil {
		t.Fatalf("resolve recording input under renewed lease: %v", err)
	}
	if len(storedRenderInput.Capture) != 2 || storedRenderInput.Capture[0].SequenceNumber != 0 || storedRenderInput.Capture[0].CaptureEpoch != 1 || storedRenderInput.Capture[0].KeyHandle != historicalKeyHandle ||
		storedRenderInput.Capture[1].SequenceNumber != 2 || storedRenderInput.Capture[1].CaptureEpoch != renderAuthority.CaptureEpoch || storedRenderInput.Capture[1].KeyHandle != renderAuthority.KeyHandle {
		t.Fatalf("multi-epoch render capture input = %#v", storedRenderInput.Capture)
	}
	historicalKey, err := renderRepository.GetCaptureKey(ctx, recordingrender.AccessKeyInput{Authority: renderAuthority, CaptureEpoch: 1})
	if err != nil || historicalKey.KeyHandle != historicalKeyHandle || historicalKey.Context.CaptureEpoch != 1 || historicalKey.Context.JobID != job.ID.String() {
		t.Fatalf("historical render key = %#v error=%v", historicalKey, err)
	}
	currentKey, err := renderRepository.GetCaptureKey(ctx, recordingrender.AccessKeyInput{Authority: renderAuthority, CaptureEpoch: renderAuthority.CaptureEpoch})
	if err != nil || currentKey.KeyHandle != renderAuthority.KeyHandle || currentKey.Context.CaptureEpoch != renderAuthority.CaptureEpoch {
		t.Fatalf("current render key = %#v error=%v", currentKey, err)
	}
	if _, err := renderRepository.GetCaptureKey(ctx, recordingrender.AccessKeyInput{Authority: renderAuthority, CaptureEpoch: 2}); !errors.Is(err, recordingrender.ErrKeyNotFound) {
		t.Fatalf("unreferenced capture key error = %v, want %v", err, recordingrender.ErrKeyNotFound)
	}
	if _, err := renderRepository.GetCaptureKey(ctx, recordingrender.AccessKeyInput{Authority: originalRenderAuthority, CaptureEpoch: 1}); !errors.Is(err, recordingrender.ErrKeyNotFound) {
		t.Fatalf("historical key under stale render lease error = %v, want %v", err, recordingrender.ErrKeyNotFound)
	}
	if _, err := renderRepository.ResolveInput(ctx, originalRenderAuthority); !errors.Is(err, recordingrender.ErrLeaseStale) {
		t.Fatalf("old recording input lease after renewal error = %v", err)
	}
	casAllocation, err := renderRepository.ReserveObject(ctx, recordingrender.ReserveObjectInput{
		Authority: renderAuthority, Purpose: recordingrender.PurposeTranscriptionManifest,
		ReservationRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be028"),
	}, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be027"), "recordings/render/finalize-cas.json", time.Now().UTC())
	if err != nil {
		t.Fatalf("reserve render object for finalization CAS: %v", err)
	}
	casChecksum := bytes.Repeat([]byte{0x27}, sha256.Size)
	casFirst := casAllocation
	casFirst.ExpectedContentType = "application/json"
	casFirst.ExpectedByteSize = 127
	casFirst.ExpectedSHA256 = casChecksum
	casFirst.UploadTokenHash = bytes.Repeat([]byte{0x28}, sha256.Size)
	casFirst.UploadExpiresAt = &renderAuthority.LeaseExpiresAt
	if _, err := renderRepository.FinalizeObject(ctx, casFirst); err != nil {
		t.Fatalf("finalize render object for CAS: %v", err)
	}
	casConflicting := casAllocation
	casConflicting.ExpectedContentType = "application/json"
	casConflicting.ExpectedByteSize = 128
	casConflicting.ExpectedSHA256 = bytes.Repeat([]byte{0x29}, sha256.Size)
	casConflicting.UploadTokenHash = bytes.Repeat([]byte{0x2a}, sha256.Size)
	casConflicting.UploadExpiresAt = &renderAuthority.LeaseExpiresAt
	if _, err := renderRepository.FinalizeObject(ctx, casConflicting); err == nil {
		t.Fatal("conflicting stale render finalization unexpectedly overwrote allocated facts")
	}
	casMatching := casFirst
	casMatching.UploadTokenHash = bytes.Repeat([]byte{0x2b}, sha256.Size)
	if _, err := renderRepository.FinalizeObject(ctx, casMatching); err != nil {
		t.Fatalf("matching render finalization token reissue: %v", err)
	}
	casStored, err := renderRepository.GetObjectAllocation(ctx, renderAuthority, casAllocation.ID)
	if err != nil {
		t.Fatalf("read render finalization CAS result: %v", err)
	}
	if casStored.ExpectedContentType != casFirst.ExpectedContentType || casStored.ExpectedByteSize != casFirst.ExpectedByteSize || !bytes.Equal(casStored.ExpectedSHA256, casFirst.ExpectedSHA256) || !bytes.Equal(casStored.UploadTokenHash, casMatching.UploadTokenHash) {
		t.Fatalf("render finalization CAS result = content_type %q size %d checksum %x token %x", casStored.ExpectedContentType, casStored.ExpectedByteSize, casStored.ExpectedSHA256, casStored.UploadTokenHash)
	}
	commitObject := func(allocationValue, requestValue, key string, purpose recordingrender.ObjectPurpose, contentType string, size int64, digestByte byte, duration *int64) recordingrender.CommitObjectReference {
		t.Helper()
		allocationID := mustID(t, allocationValue)
		allocation, reserveErr := renderRepository.ReserveObject(ctx, recordingrender.ReserveObjectInput{
			Authority: renderAuthority, Purpose: purpose, ReservationRequestID: mustID(t, requestValue),
		}, allocationID, key, time.Now().UTC())
		if reserveErr != nil {
			t.Fatalf("reserve %s render object: %v", purpose, reserveErr)
		}
		checksum := make([]byte, sha256.Size)
		for index := range checksum {
			checksum[index] = digestByte
		}
		uploadHash := sha256.Sum256([]byte(allocationValue))
		uploadExpiresAt := renderAuthority.LeaseExpiresAt
		allocation.ExpectedContentType = contentType
		allocation.ExpectedByteSize = size
		allocation.ExpectedSHA256 = checksum
		allocation.ExpectedDurationMillis = duration
		allocation.UploadTokenHash = uploadHash[:]
		allocation.UploadExpiresAt = &uploadExpiresAt
		allocation, finalizeErr := renderRepository.FinalizeObject(ctx, allocation)
		if finalizeErr != nil {
			t.Fatalf("finalize %s render object: %v", purpose, finalizeErr)
		}
		committed, commitErr := renderRepository.CommitObject(ctx, allocation, objectstorage.ObjectFacts{Object: objectstorage.Object{
			Key: key, ETag: "immutable-" + allocationValue, ChecksumSHA256: base64.StdEncoding.EncodeToString(checksum), ContentType: contentType, Size: size,
		}}, time.Now().UTC())
		if commitErr != nil {
			t.Fatalf("commit %s render object: %v", purpose, commitErr)
		}
		return recordingrender.CommitObjectReference{AllocationID: committed.AllocationID, Purpose: committed.Purpose, Object: committed.Object, DurationMillis: committed.DurationMillis}
	}
	duration := render.Authority.Envelope.PresentationDurationMillis
	video := commitObject("6a9b6a12-7457-4fe9-a58b-8b234d0be020", "6a9b6a12-7457-4fe9-a58b-8b234d0be021", "recordings/render/video.mp4", recordingrender.PurposeRecordingVideo, "video/mp4", 128, 0x21, &duration)
	manifest := commitObject("6a9b6a12-7457-4fe9-a58b-8b234d0be022", "6a9b6a12-7457-4fe9-a58b-8b234d0be023", "recordings/render/transcription.json", recordingrender.PurposeTranscriptionManifest, "application/json", 128, 0x22, nil)
	chunkDuration := duration
	if chunkDuration > 15*60*1000 {
		chunkDuration = 15 * 60 * 1000
	}
	audio := commitObject("6a9b6a12-7457-4fe9-a58b-8b234d0be024", "6a9b6a12-7457-4fe9-a58b-8b234d0be025", "recordings/render/audio.flac", recordingrender.PurposeTranscriptionAudio, "audio/flac", 128, 0x23, &chunkDuration)
	ffprobeDigest := sha256.Sum256([]byte("recording render integration ffprobe facts"))
	commitInput := recordingrender.CommitInput{
		Authority: renderAuthority, PresentationSHA256: presentationDigest, DurationMillis: duration, Video: video, FFprobeFactsDigest: ffprobeDigest[:],
		TranscriptionSource: &recordingrender.TranscriptionSource{
			SchemaVersion: recordingrender.TranscriptionSourceSchemaVersion, PresentationSHA256: presentationDigest, Manifest: manifest,
			Chunks: []recordingrender.TranscriptionChunk{{
				ChunkID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be026"), Index: 0, Generation: render.FencingGeneration,
				StartMillis: 0, EndMillis: chunkDuration, SourceStartMillis: 0, SourceEndMillis: chunkDuration,
				ParticipantRef: "participant-integration", ParticipantGeneration: 1, DisplayNameSnapshot: "Participant",
				TrackID: "microphone-integration", TrackEpoch: "track-epoch-integration", IdentityKind: "participant", TrackClass: "microphone", Object: audio,
			}},
		},
	}
	commitInput.CommitDigest, err = recordingrender.CommitDigest(commitInput)
	if err != nil || commitInput.Validate() != nil {
		t.Fatalf("build recording render commit: digest=%v validation=%v", err, commitInput.Validate())
	}
	if _, err := renderRepository.Commit(ctx, commitInput, time.Now().UTC()); !errors.Is(err, recordingrender.ErrTranscriptionUnavailable) {
		t.Fatalf("on-demand source with disabled runtime error = %v, want %v", err, recordingrender.ErrTranscriptionUnavailable)
	}
	var sourceCount, renderCommitCount int
	if err := pool.QueryRow(ctx, `select (select count(*) from recording_transcription_sources where recording_id = $1), (select count(*) from recording_render_commits where recording_id = $1)`, reservation.RecordingID.Bytes()).Scan(&sourceCount, &renderCommitCount); err != nil {
		t.Fatalf("inspect disabled-runtime render rollback: %v", err)
	}
	if sourceCount != 0 || renderCommitCount != 0 {
		t.Fatalf("disabled transcription runtime left committed state: sources=%d render_commits=%d", sourceCount, renderCommitCount)
	}
	commitTransaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin render timestamp regression transaction: %v", err)
	}
	committedAt := time.Now().UTC().Add(-time.Second).Truncate(time.Microsecond)
	uuidValue := func(value utilities.ID) pgtype.UUID { return pgtype.UUID{Bytes: value.Bytes(), Valid: true} }
	committedArtifact, err := sqlc.New(commitTransaction).CompleteRecordingRender(ctx, sqlc.CompleteRecordingRenderParams{
		RenderJobID: uuidValue(commitInput.Authority.JobID), TenantID: uuidValue(commitInput.Authority.TenantID), RecordingID: uuidValue(commitInput.Authority.RecordingID),
		AttemptCount: int32(commitInput.Authority.AttemptCount), FencingGeneration: commitInput.Authority.FencingGeneration, CaptureEpoch: commitInput.Authority.CaptureEpoch,
		RenderInputHandle: uuidValue(commitInput.Authority.RenderInputHandle), CommitDigest: commitInput.CommitDigest, PresentationSha256: commitInput.PresentationSHA256,
		DurationMillis: commitInput.DurationMillis, VideoAllocationID: uuidValue(commitInput.Video.AllocationID), FfprobeFactsDigest: commitInput.FFprobeFactsDigest,
		TranscriptionJobIds: []pgtype.UUID{}, CommittedAt: pgtype.Timestamptz{Time: committedAt, Valid: true},
	})
	if err != nil {
		_ = commitTransaction.Rollback(ctx)
		t.Fatalf("complete render timestamp regression transaction: %v", err)
	}
	if !committedArtifact.CreatedAt.Valid || !committedArtifact.CommittedAt.Valid || !committedArtifact.CreatedAt.Time.Equal(committedAt) || !committedArtifact.CommittedAt.Time.Equal(committedAt) {
		_ = commitTransaction.Rollback(ctx)
		t.Fatalf("render artifact timestamps = created %v committed %v; want %v", committedArtifact.CreatedAt, committedArtifact.CommittedAt, committedAt)
	}
	if err := commitTransaction.Rollback(ctx); err != nil {
		t.Fatalf("roll back render timestamp regression transaction: %v", err)
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
	if _, err := pool.Exec(ctx, `update sync_recordings set status = 'stopped', completed_at = now(), updated_at = now() where recording_id = $1`, reservation.RecordingID.Bytes()); err != nil {
		t.Fatalf("complete prior Sync recording fixture: %v", err)
	}
	noShowStartOperationID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bef01")
	noShowRecordingID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bef02")
	noShowStartFingerprint := sha256.Sum256([]byte("recording pipeline no-show start"))
	if _, err := pool.Exec(ctx, `insert into sync_external_operations(tenant_id, space_id, episode_id, external_operation_id, request_key, request_fingerprint, operation_name, recording_id, payload) values($1, $2, $3, $4, 'recording_pipeline_no_show_start', $5, 'start_recording', $6, jsonb_build_object('recordingId', $6::uuid::text))`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), noShowStartOperationID.Bytes(), noShowStartFingerprint[:], noShowRecordingID.Bytes()); err != nil {
		t.Fatalf("seed pending no-show start operation: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into sync_recordings(tenant_id, space_id, episode_id, recording_id, status, generation, start_external_operation_id) values($1, $2, $3, $4, 'starting', 1, $5)`, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), noShowRecordingID.Bytes(), noShowStartOperationID.Bytes()); err != nil {
		t.Fatalf("seed no-show Sync recording: %v", err)
	}
	noShowInput := recordingpipeline.ReservationInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		RecordingID: noShowRecordingID, IdempotencyKey: noShowStartOperationID.String(), ParticipantCount: 2,
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
	terminalBeforeStop, err := repository.GetPipeline(ctx, tenantID, noShow.RecordingID)
	if err != nil || terminalBeforeStop.State != recordingpipeline.StateTerminalFailure {
		t.Fatalf("expired pipeline before stop: %+v, %v", terminalBeforeStop, err)
	}
	var expiredJobState, expiredJobError string
	if err := pool.QueryRow(ctx, `select state, error_code from recording_jobs where recording_id = $1 and kind = 'capture'`, noShow.RecordingID.Bytes()).Scan(&expiredJobState, &expiredJobError); err != nil || expiredJobState != string(recordingpipeline.JobStateTerminalFailure) || expiredJobError != "capture_reservation_expired" {
		t.Fatalf("expired no-show job = state %q error %q, %v", expiredJobState, expiredJobError, err)
	}
	var failureOperationStatus, startOperationStatus, failureRecordingID, failureStartOperationID, failureCode string
	if err := pool.QueryRow(ctx, `select failure.status, start_operation.status, failure.payload ->> 'recordingId', failure.payload ->> 'startOperationId', failure.payload ->> 'failureCode' from sync_external_operations failure join sync_external_operations start_operation on start_operation.external_operation_id = (failure.payload ->> 'startOperationId')::uuid where failure.tenant_id = $1 and failure.episode_id = $2 and failure.operation_name = 'recording_capture_failed' and failure.recording_id = $3`, tenantID.Bytes(), episodeID.Bytes(), noShow.RecordingID.Bytes()).Scan(&failureOperationStatus, &startOperationStatus, &failureRecordingID, &failureStartOperationID, &failureCode); err != nil {
		t.Fatalf("read expired no-show Sync failure: %v", err)
	}
	if failureOperationStatus != "pending" || startOperationStatus != "pending" || failureRecordingID != noShow.RecordingID.String() || failureStartOperationID != noShowStartOperationID.String() || failureCode != "capture_reservation_expired" {
		t.Fatalf("expired no-show Sync failure = status %q start status %q recording %q start %q code %q", failureOperationStatus, startOperationStatus, failureRecordingID, failureStartOperationID, failureCode)
	}
	terminalAfterStop, err := repository.RequestStop(ctx, tenantID, episodeID, noShow.RecordingID, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be01f"))
	if err != nil || terminalAfterStop.State != terminalBeforeStop.State || terminalAfterStop.StopRequestedAt == nil {
		t.Fatalf("terminal recording must acknowledge stop without reviving it: %+v, %v", terminalAfterStop, err)
	}

	if recovered, err := repository.RecoverExpired(ctx); err != nil || len(recovered) != 0 {
		t.Fatalf("expired no-show job must not require a worker-driven recovery: %+v, %v", recovered, err)
	}
	failedRetry, err := repository.Fail(ctx, recordingpipeline.FailureInput{
		LeaseInput: recordingpipeline.LeaseInput{JobID: retryJob.ID, AttemptCount: retryJob.AttemptCount, FencingGeneration: retryJob.FencingGeneration, LeaseToken: retryJob.Authority.LeaseToken, LeaseOwner: retryJob.Authority.LeaseOwner, CaptureEpoch: retryJob.Authority.Envelope.CaptureEpoch, EnvelopeDigest: retryJob.Authority.EnvelopeDigest},
		ErrorCode:  "capture_shutdown_failed", ErrorDetail: "qualification fixture", AvailableAt: time.Now(),
	})
	if err != nil || failedRetry.State != recordingpipeline.JobStatePending {
		t.Fatalf("fail stopped capture attempt: %+v, %v", failedRetry, err)
	}
	stoppedRecovery, err := repository.RecoverExpired(ctx)
	if err != nil || len(stoppedRecovery) != 1 || stoppedRecovery[0].State != recordingpipeline.JobStateTerminalFailure || (stoppedRecovery[0].ErrorCode == nil || *stoppedRecovery[0].ErrorCode != "capture_stopped_before_completion") {
		t.Fatalf("stopped pending capture cannot be retried: %+v, %v", stoppedRecovery, err)
	}
	if err := pool.QueryRow(ctx, `select reserved_participants from recording_capacity where id = 1`).Scan(&reservedParticipants); err != nil || reservedParticipants != 0 {
		t.Fatalf("stopped capture capacity was not released: participants=%d, %v", reservedParticipants, err)
	}
	if recovered, err := repository.RecoverExpired(ctx); err != nil || len(recovered) != 0 {
		t.Fatalf("stopped capture release must be idempotent: %+v, %v", recovered, err)
	}

	handoffInput := recordingpipeline.ReservationInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		RecordingID:           mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be041"),
		IdempotencyKey:        "recorder-integration-handoff",
		ParticipantCount:      1,
		PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
		MaxDuration:           time.Hour,
		InputBitrateBPS:       1_000_000,
	}
	handoffReservation, err := repository.Reserve(ctx, handoffInput, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be042"))
	if err != nil {
		t.Fatalf("reserve capture handoff: %v", err)
	}
	firstHandoffClaim, err := repository.Claim(ctx, recordingpipeline.ClaimInput{
		ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be043"),
		Kind:           recordingpipeline.JobKindCapture, Owner: "handoff-one", LeaseToken: "handoff-lease-one", LeaseFor: time.Minute,
	})
	if err != nil || firstHandoffClaim.Authority == nil {
		t.Fatalf("claim capture handoff: %+v, %v", firstHandoffClaim, err)
	}
	firstHandoffLease := recordingpipeline.LeaseInput{
		JobID: firstHandoffClaim.ID, AttemptCount: firstHandoffClaim.AttemptCount, FencingGeneration: firstHandoffClaim.FencingGeneration,
		LeaseToken: firstHandoffClaim.Authority.LeaseToken, LeaseOwner: firstHandoffClaim.Authority.LeaseOwner, LeaseFor: time.Minute,
		CaptureEpoch: firstHandoffClaim.Authority.Envelope.CaptureEpoch, EnvelopeDigest: firstHandoffClaim.Authority.EnvelopeDigest,
	}
	staleHandoffLease := firstHandoffLease
	staleHandoffLease.FencingGeneration--
	if _, err := repository.RelinquishCapture(ctx, staleHandoffLease); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("stale capture handoff error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
	}
	relinquished, err := repository.RelinquishCapture(ctx, firstHandoffLease)
	if err != nil {
		t.Fatalf("relinquish capture handoff: %v", err)
	}
	if relinquished.State != recordingpipeline.JobStatePending || relinquished.AttemptCount != firstHandoffClaim.AttemptCount-1 || relinquished.AttemptLimit != firstHandoffClaim.AttemptLimit || relinquished.FencingGeneration != firstHandoffClaim.FencingGeneration || relinquished.LeaseToken != nil || relinquished.LeaseOwner != nil || relinquished.LeaseExpiresAt != nil {
		t.Fatalf("relinquished capture job = %+v", relinquished)
	}
	replayedRelinquish, err := repository.RelinquishCapture(ctx, firstHandoffLease)
	if err != nil || replayedRelinquish.ID != relinquished.ID || replayedRelinquish.AttemptCount != relinquished.AttemptCount || replayedRelinquish.FencingGeneration != relinquished.FencingGeneration {
		t.Fatalf("replayed capture relinquish = %+v, %v", replayedRelinquish, err)
	}
	reservationAfterHandoff, err := repository.GetReservation(ctx, tenantID, handoffReservation.ID)
	if err != nil || !reservationAfterHandoff.EndsAt.Equal(handoffReservation.EndsAt) {
		t.Fatalf("capture relinquish changed reservation deadline: before=%s after=%s err=%v", handoffReservation.EndsAt, reservationAfterHandoff.EndsAt, err)
	}
	secondHandoffClaim, err := repository.Claim(ctx, recordingpipeline.ClaimInput{
		ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be044"),
		Kind:           recordingpipeline.JobKindCapture, Owner: "handoff-two", LeaseToken: "handoff-lease-two", LeaseFor: time.Minute,
	})
	if err != nil || secondHandoffClaim.Authority == nil {
		t.Fatalf("reclaim handed-off capture: %+v, %v", secondHandoffClaim, err)
	}
	if secondHandoffClaim.ID != firstHandoffClaim.ID || secondHandoffClaim.AttemptCount != firstHandoffClaim.AttemptCount || secondHandoffClaim.AttemptLimit != firstHandoffClaim.AttemptLimit || secondHandoffClaim.FencingGeneration != firstHandoffClaim.FencingGeneration+1 || secondHandoffClaim.Authority.Envelope.CaptureEpoch != firstHandoffClaim.Authority.Envelope.CaptureEpoch+1 || secondHandoffClaim.Authority.Envelope.KeyHandle == firstHandoffClaim.Authority.Envelope.KeyHandle || secondHandoffClaim.Authority.Envelope.SignalingHandle == firstHandoffClaim.Authority.Envelope.SignalingHandle || secondHandoffClaim.Authority.Envelope.PlanHandle == firstHandoffClaim.Authority.Envelope.PlanHandle {
		t.Fatalf("capture handoff did not issue fresh authority: first=%+v second=%+v", firstHandoffClaim.Authority, secondHandoffClaim.Authority)
	}
	if _, err := repository.Heartbeat(ctx, firstHandoffLease); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("old handoff authority write after same-count reclaim error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
	}
	if _, err := repository.RelinquishCapture(ctx, firstHandoffLease); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("old handoff lease after reclaim error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
	}
}

func TestRecordingReservationAdmissionSerializesCaptureCompletion(t *testing.T) {
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

	tenantID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed01")
	spaceID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed02")
	episodeID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed03")
	firstRecordingID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed04")
	secondRecordingID := mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed05")
	defer func() {
		_, _ = pool.Exec(ctx, `delete from recording_job_attempt_authorities where job_id in (select id from recording_jobs where tenant_id = $1)`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_jobs where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_pipelines where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recording_reservations where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from recordings where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from episodes where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from spaces where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from tenants where id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `update recording_capacity set reserved_episodes = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0 where id = 1`)
	}()
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, 'recording admission serialization') on conflict do nothing`, tenantID.Bytes()); err != nil {
		t.Fatalf("seed serialization tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, name, tenant_id, slug, media_plane) values ($1, 'recording admission serialization', $2, 'recording-admission-serialization', 'cf_sfu') on conflict do nothing`, spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed serialization space: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot) values ($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}'::jsonb) on conflict do nothing`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed serialization Episode: %v", err)
	}
	if _, err := pool.Exec(ctx, `update recording_capacity set reserved_episodes = 0, reserved_participants = 0, reserved_input_bitrate_bps = 0 where id = 1`); err != nil {
		t.Fatalf("reset serialization capacity: %v", err)
	}

	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	firstInput := recordingpipeline.ReservationInput{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: firstRecordingID,
		IdempotencyKey: "recording-admission-serialization-first", ParticipantCount: 1,
		PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
		MaxDuration:           2 * time.Hour, InputBitrateBPS: recordingpipeline.MaximumInputBitrateBPS,
	}
	if _, err := repository.Reserve(ctx, firstInput, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed06")); err != nil {
		t.Fatalf("reserve completing capture: %v", err)
	}
	claimed, err := repository.Claim(ctx, recordingpipeline.ClaimInput{
		ClaimRequestID: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed07"),
		Kind:           recordingpipeline.JobKindCapture,
		Owner:          "capture-serialization",
		LeaseToken:     "capture-serialization-lease",
		LeaseFor:       5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("claim completing capture: %v", err)
	}
	if claimed.Authority == nil {
		t.Fatal("claimed capture has no authority")
	}
	if _, err := pool.Exec(ctx, `update recording_capacity set reserved_episodes = 10 where id = 1`); err != nil {
		t.Fatalf("seed ten outstanding captures: %v", err)
	}

	completeConnection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire completion connection: %v", err)
	}
	defer completeConnection.Release()
	admitConnection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire admission connection: %v", err)
	}
	defer admitConnection.Release()
	completeTx, err := completeConnection.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatalf("begin capture completion: %v", err)
	}
	defer completeTx.Rollback(ctx)
	if _, err := sqlc.New(completeTx).CompleteCaptureRecordingJob(ctx, sqlc.CompleteCaptureRecordingJobParams{
		ID:                   pgtype.UUID{Bytes: claimed.ID.Bytes(), Valid: true},
		AttemptCount:         int32(claimed.AttemptCount),
		FencingGeneration:    claimed.FencingGeneration,
		LeaseToken:           pgtype.Text{String: claimed.Authority.LeaseToken, Valid: true},
		LeaseOwner:           pgtype.Text{String: claimed.Authority.LeaseOwner, Valid: true},
		CaptureEpoch:         claimed.Authority.Envelope.CaptureEpoch,
		EnvelopeDigest:       claimed.Authority.EnvelopeDigest,
		RenderJobID:          pgtype.UUID{Bytes: mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed08").Bytes(), Valid: true},
		PayloadSchemaVersion: recordingpipeline.DefaultPayloadSchemaVersion,
		AttemptLimit:         recordingpipeline.DefaultRenderAttemptLimit,
	}); err != nil {
		t.Fatalf("complete capture before admission race: %v", err)
	}

	admittingRepository := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(admitConnection), admitConnection, nil)
	secondInput := firstInput
	secondInput.RecordingID = secondRecordingID
	secondInput.IdempotencyKey = "recording-admission-serialization-second"
	type reserveResult struct {
		reservation recordingpipeline.Reservation
		err         error
	}
	reserveResultChannel := make(chan reserveResult, 1)
	go func() {
		reserved, reserveErr := admittingRepository.Reserve(ctx, secondInput, mustID(t, "6a9b6a12-7457-4fe9-a58b-8b234d0bed09"))
		reserveResultChannel <- reserveResult{reservation: reserved, err: reserveErr}
	}()
	waitForPostgresLock(t, ctx, pool, admitConnection.Conn().PgConn().PID())
	if err := completeTx.Commit(ctx); err != nil {
		t.Fatalf("commit capture completion: %v", err)
	}
	result := <-reserveResultChannel
	if !errors.Is(result.err, recordingpipeline.ErrRecordingCapacityUnavailable) {
		t.Fatalf("reservation racing render enqueue = %+v, %v; want capacity unavailable", result.reservation, result.err)
	}
	var reservedEpisodes, activeRenderPhases int
	if err := pool.QueryRow(ctx, `select reserved_episodes, (select count(*) from recording_pipelines where capture_completed_at is not null and state in ('render_queued', 'rendering', 'verifying', 'retryable_failure')) from recording_capacity where id = 1`).Scan(&reservedEpisodes, &activeRenderPhases); err != nil {
		t.Fatalf("read serialized capacity: %v", err)
	}
	if reservedEpisodes != 9 || activeRenderPhases != 1 {
		t.Fatalf("serialized capacity = capture:%d render:%d, want 9+1", reservedEpisodes, activeRenderPhases)
	}
}

func waitForPostgresLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool, processID uint32) {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `select coalesce(wait_event_type = 'Lock', false) from pg_stat_activity where pid = $1`, processID).Scan(&waiting); err != nil {
			t.Fatalf("observe admission lock: %v", err)
		}
		if waiting {
			return
		}
		select {
		case <-deadline.C:
			t.Fatal("reservation did not wait for the capture-completion capacity lock")
		case <-ticker.C:
		}
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
	for _, table := range []string{"recording_render_commits", "recording_render_object_allocations", "recording_render_inputs", "recording_bundle_allocations", "recording_data_keys"} {
		if _, err := transaction.Exec(ctx, `alter table `+table+` disable trigger user`); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `delete from `+table); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `alter table `+table+` enable trigger user`); err != nil {
			return err
		}
	}
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

func resetRecordingPresentations(ctx context.Context, pool *pgxpool.Pool) error {
	transaction, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer transaction.Rollback(ctx)
	for _, table := range []string{
		"recording_presentation_reactions",
		"recording_presentation_assets",
		"recording_presentations",
		"recording_presentation_sources",
		"recording_presentation_baselines",
	} {
		if _, err := transaction.Exec(ctx, `alter table `+table+` disable trigger user`); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `delete from `+table); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `alter table `+table+` enable trigger user`); err != nil {
			return err
		}
	}
	return transaction.Commit(ctx)
}

func cleanupRecordingSyncLifecycle(ctx context.Context, pool *pgxpool.Pool, tenantID utilities.ID) error {
	transaction, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer transaction.Rollback(ctx)
	if _, err := transaction.Exec(ctx, `delete from observability_journey_events where journey_id in (select journey_id from sync_external_operations where tenant_id = $1 and journey_id is not null)`, tenantID.Bytes()); err != nil {
		return err
	}
	for _, table := range []string{"sync_control_events", "sync_recordings", "sync_external_operations"} {
		if _, err := transaction.Exec(ctx, `delete from `+table+` where tenant_id = $1`, tenantID.Bytes()); err != nil {
			return err
		}
	}
	return transaction.Commit(ctx)
}

type recordingPresentationStoredObject struct {
	body   []byte
	object objectstorage.Object
}

type recordingPresentationObjectStore struct {
	mu      sync.Mutex
	objects map[string]recordingPresentationStoredObject
}

func newRecordingPresentationObjectStore() *recordingPresentationObjectStore {
	return &recordingPresentationObjectStore{objects: make(map[string]recordingPresentationStoredObject)}
}

func (store *recordingPresentationObjectStore) PutObject(_ context.Context, input objectstorage.PutObjectInput) (objectstorage.Object, error) {
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return objectstorage.Object{}, err
	}
	if int64(len(body)) != input.ContentLength {
		return objectstorage.Object{}, objectstorage.ErrInvalidObjectSize
	}
	digest := sha256.Sum256(body)
	object := objectstorage.Object{
		Key: input.Key, ETag: fmt.Sprintf(`"%x"`, digest[:8]),
		ContentType: input.ContentType, Size: input.ContentLength,
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if input.IfNoneMatch {
		if _, exists := store.objects[input.Key]; exists {
			return objectstorage.Object{}, objectstorage.ErrObjectAlreadyExists
		}
	}
	store.objects[input.Key] = recordingPresentationStoredObject{body: append([]byte(nil), body...), object: object}
	return object, nil
}

func (store *recordingPresentationObjectStore) GetObject(_ context.Context, key string) (objectstorage.ObjectReader, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	stored, exists := store.objects[key]
	if !exists {
		return objectstorage.ObjectReader{}, objectstorage.ErrObjectNotFound
	}
	return objectstorage.ObjectReader{
		Object: stored.object,
		Body:   io.NopCloser(bytes.NewReader(stored.body)),
	}, nil
}

func (store *recordingPresentationObjectStore) Contains(key string) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	_, exists := store.objects[key]
	return exists
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

func (p *recordingCapturePlaneFixture) Resolve(context.Context, captureplane.CaptureIdentity) (captureplane.CapturePlane, error) {
	return p, nil
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

func (p *recordingCapturePlaneFixture) PullCaptureTracks(_ context.Context, input captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	return captureplane.PullCaptureTracksResult{
		Connection:  captureplane.CaptureConnection{ConnectionReference: input.Connection, CaptureEpoch: input.Metadata.CaptureEpoch, PlanRevision: input.Metadata.PlanRevision},
		Tracks:      []captureplane.PulledCaptureTrack{{CaptureTrack: input.Tracks[0], MID: "0"}},
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationRemoteAnswer, Description: &captureplane.Description{Type: "answer", SDP: "v=0\r\n"}},
	}, nil
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
