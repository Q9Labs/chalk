package postgres_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingPresentationCompletionSurvivesCaptureRestart(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin fixture transaction: %v", err)
	}
	defer func() {
		if rollbackErr := transaction.Rollback(ctx); rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			t.Errorf("roll back fixture transaction: %v", rollbackErr)
		}
	}()

	fixture := seedCaptureRestartPresentation(t, ctx, transaction)
	repository := postgres.NewRecordingPresentationCompletionSourceRepository(sqlc.New(transaction))
	source, err := repository.LoadCompletionSource(ctx, fixture.authority)
	if err != nil {
		t.Fatalf("load completion source after capture restart: %v", err)
	}
	if source.CaptureEpoch != fixture.authority.CaptureEpoch || !source.CaptureReadyAt.Equal(fixture.captureReadyAt) {
		t.Fatalf("completion clock = epoch %d at %s, want epoch %d at %s", source.CaptureEpoch, source.CaptureReadyAt, fixture.authority.CaptureEpoch, fixture.captureReadyAt)
	}
	if source.DurationMillis != 2_500 {
		t.Fatalf("completion duration = %d, want bundles from both attempts through 2500", source.DurationMillis)
	}
	if source.CapturePlanStartRevision != 2 || len(source.CapturePlans) != 4 {
		t.Fatalf("completion plan cursor = %d with %d plans, want origin 2 with 4 projected plans", source.CapturePlanStartRevision, len(source.CapturePlans))
	}
	wantSource := [][2]int64{{1, 1}, {1, 2}, {1, 3}, {2, 1}}
	for index, plan := range source.CapturePlans {
		wantCursor := int64(index + 1)
		if plan.Revision != wantCursor || int64(plan.Plan.Authority().CaptureEpoch) != wantSource[index][0] || int64(plan.Plan.Revision()) != wantSource[index][1] {
			t.Fatalf("ordered plan %d = cursor %d, source epoch %d revision %d", index, plan.Revision, plan.Plan.Authority().CaptureEpoch, plan.Plan.Revision())
		}
	}

	stale := fixture.authority
	stale.LeaseOwner = "different-worker"
	if _, err := repository.LoadCompletionSource(ctx, stale); !errors.Is(err, recordingpresentation.ErrCompletionSourceNotFound) {
		t.Fatalf("mismatched current worker error = %v, want %v", err, recordingpresentation.ErrCompletionSourceNotFound)
	}

	objects := newRecordingPresentationObjectStore()
	freezer, err := recordingpresentation.NewFreezer(repository, objects)
	if err != nil {
		t.Fatalf("configure presentation freezer: %v", err)
	}
	prepared, err := freezer.Prepare(ctx, fixture.authority)
	if err != nil {
		t.Fatalf("prepare presentation after capture restart: %v", err)
	}
	reader, err := objects.GetObject(ctx, prepared.PresentationObject.Key)
	if err != nil {
		t.Fatalf("read prepared presentation: %v", err)
	}
	timelineBytes, err := io.ReadAll(reader.Body)
	closeErr := reader.Body.Close()
	if err != nil {
		t.Fatalf("read prepared presentation body: %v", err)
	}
	if closeErr != nil {
		t.Fatalf("close prepared presentation body: %v", closeErr)
	}
	timeline, err := recordingpresentation.Decode(timelineBytes)
	if err != nil {
		t.Fatalf("decode prepared presentation: %v", err)
	}
	if prepared.CaptureEpoch != fixture.authority.CaptureEpoch || prepared.DurationMillis != 2_500 ||
		timeline.Clock.CaptureEpoch != fixture.authority.CaptureEpoch || timeline.SourceCursors.CapturePlanEndRevision != 4 {
		t.Fatalf("prepared presentation = epoch %d duration %d clock epoch %d plan end %d", prepared.CaptureEpoch, prepared.DurationMillis, timeline.Clock.CaptureEpoch, timeline.SourceCursors.CapturePlanEndRevision)
	}
	wantRetryEpoch, err := recordingbundle.ComposeTrackEpoch(2, 1)
	if err != nil {
		t.Fatal(err)
	}
	var foundRetrySource bool
	for _, event := range timeline.Events {
		if changed, ok := event.(*recordingpresentation.MediaSourceChangedEvent); ok && changed.Source.TrackID == "camera-four" {
			foundRetrySource = changed.Source.Epoch == int64(wantRetryEpoch)
		}
	}
	if !foundRetrySource {
		t.Fatalf("presentation did not preserve retry track epoch %d", wantRetryEpoch)
	}
}

type captureRestartPresentationFixture struct {
	authority      recordingpresentation.CompletionAuthority
	captureReadyAt time.Time
}

func seedCaptureRestartPresentation(t *testing.T, ctx context.Context, transaction pgx.Tx) captureRestartPresentationFixture {
	t.Helper()
	tenantID := newCaptureRestartID(t)
	spaceID := newCaptureRestartID(t)
	episodeID := newCaptureRestartID(t)
	recordingID := newCaptureRestartID(t)
	reservationID := newCaptureRestartID(t)
	jobID := newCaptureRestartID(t)
	presentationHandle := newCaptureRestartID(t)
	participantID := newCaptureRestartID(t)
	claimOneID := newCaptureRestartID(t)
	claimTwoID := newCaptureRestartID(t)
	planOneHandle := newCaptureRestartID(t)
	planTwoHandle := newCaptureRestartID(t)
	captureReadyAt := time.Now().UTC().Truncate(time.Microsecond).Add(-10 * time.Second)
	leaseExpiresAt := time.Now().UTC().Add(10 * time.Minute)
	digestOne := bytes.Repeat([]byte{0x11}, sha256.Size)
	digestTwo := bytes.Repeat([]byte{0x22}, sha256.Size)

	statements := []struct {
		name string
		sql  string
		args []any
	}{
		{name: "tenant", sql: `insert into tenants(id, name) values($1, 'capture restart presentation')`, args: []any{tenantID.Bytes()}},
		{name: "space", sql: `insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Capture restart', $2, $3, 'cf_sfu')`, args: []any{spaceID.Bytes(), tenantID.Bytes(), "capture-restart-" + spaceID.String()}},
		{name: "Episode", sql: `insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":3600,"maximum_episode_duration_seconds":7200,"linger_window_seconds":0}'::jsonb)`, args: []any{episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()}},
		{name: "recording", sql: `insert into recordings(id, tenant_id, space_id, episode_id, status, storage_provider) values($1, $2, $3, $4, 'processing', 's3')`, args: []any{recordingID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()}},
		{name: "reservation", sql: `insert into recording_reservations(id, tenant_id, space_id, episode_id, recording_id, idempotency_key, request_fingerprint, participant_count, max_duration_seconds, input_bitrate_bps, state, ends_at, policy_snapshot_version) values($1, $2, $3, $4, $5, $6, $7, 1, 3600, 1000000, 'reserved', $8, 'episode_config.v2')`, args: []any{reservationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), "capture-restart-" + recordingID.String(), bytes.Repeat([]byte{0x33}, sha256.Size), leaseExpiresAt}},
		{name: "pipeline", sql: `insert into recording_pipelines(recording_id, tenant_id, reservation_id, state, capture_epoch, capture_ready_at) values($1, $2, $3, 'capturing_segmented', 2, $4)`, args: []any{recordingID.Bytes(), tenantID.Bytes(), reservationID.Bytes(), captureReadyAt}},
		{name: "current job", sql: `insert into recording_jobs(id, tenant_id, episode_id, recording_id, kind, idempotency_key, payload_schema_version, state, available_at, attempt_count, attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation) values($1, $2, $3, $4, 'capture', $5, 1, 'leased', $6, 2, 3, 'lease-two', 'worker-two', $7, 2)`, args: []any{jobID.Bytes(), tenantID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), "capture-job-" + recordingID.String(), captureReadyAt, leaseExpiresAt}},
		{name: "first authority", sql: `insert into recording_job_attempt_authorities(job_id, attempt_count, fencing_generation, capture_epoch, claim_request_id, kind, lease_owner, lease_token, lease_expires_at, envelope_bytes, envelope_digest, issued_at) values($1, 1, 1, 1, $2, 'capture', 'worker-one', 'lease-one', $3, '{}'::bytea, $4, $5)`, args: []any{jobID.Bytes(), claimOneID.Bytes(), captureReadyAt.Add(time.Second), digestOne, captureReadyAt.Add(-2 * time.Second)}},
		{name: "current authority", sql: `insert into recording_job_attempt_authorities(job_id, attempt_count, fencing_generation, capture_epoch, claim_request_id, kind, lease_owner, lease_token, lease_expires_at, envelope_bytes, envelope_digest, issued_at) values($1, 2, 2, 2, $2, 'capture', 'worker-two', 'lease-two', $3, '{}'::bytea, $4, $5)`, args: []any{jobID.Bytes(), claimTwoID.Bytes(), leaseExpiresAt, digestTwo, captureReadyAt.Add(time.Second)}},
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed %s: %v", statement.name, err)
		}
	}

	profile, err := recordingpresentation.NewComposite720PProfile(strings.Repeat("a", sha256.Size*2))
	if err != nil {
		t.Fatalf("build presentation profile: %v", err)
	}
	profileBytes, err := json.Marshal(profile)
	if err != nil {
		t.Fatalf("encode presentation profile: %v", err)
	}
	foldedState := fmt.Sprintf(`{"control_revision":0,"status":"active","participants":[{"participant_id":%q,"display_name":"Capture Participant","admission_revision":1}]}`, participantID.String())
	if _, err := transaction.Exec(ctx, `insert into recording_presentation_baselines(presentation_handle, tenant_id, space_id, episode_id, recording_id, schema_version, profile_version, profile, space_name, episode_control_revision, episode_folded_state, participant_facts, chat_head_sequence, baseline_at) values($1, $2, $3, $4, $5, 'recording_presentation.v1', $6, $7::jsonb, 'Capture restart', 0, $8::jsonb, '[]'::jsonb, 0, $9)`, presentationHandle.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), profile.Version, profileBytes, foldedState, captureReadyAt.Add(-2*time.Second)); err != nil {
		t.Fatalf("seed presentation baseline: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into recording_presentation_sources(presentation_handle, tenant_id, space_id, episode_id, recording_id, capture_epoch, capture_ready_at, episode_control_start_revision, episode_control_events, episode_control_end_revision, participant_facts, chat_start_sequence, initial_chat_messages, whiteboard_start_revision, whiteboard_events, whiteboard_end_revision, capture_plan_start_revision) values($1, $2, $3, $4, $5, 1, $6, 0, '[]'::jsonb, 0, '[]'::jsonb, 0, '[]'::jsonb, 0, '[]'::jsonb, 0, 2)`, presentationHandle.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), captureReadyAt); err != nil {
		t.Fatalf("seed immutable presentation source: %v", err)
	}

	participant := captureplan.ParticipantSnapshot{ID: participantID, Generation: 1, DisplayName: "Capture Participant", JoinOrdinal: 1, Lifecycle: captureplan.ParticipantActive}
	plans := []struct {
		plan      captureplan.Plan
		createdAt time.Time
	}{
		{plan: newCaptureRestartPlan(t, captureRestartPlanInput{tenantID: tenantID, spaceID: spaceID, episodeID: episodeID, recordingID: recordingID, jobID: jobID, planHandle: planOneHandle, participant: participant, digest: digestOne, attemptCount: 1, fencingGeneration: 1, captureEpoch: 1, revision: 1, trackReference: "camera-one", deadline: leaseExpiresAt}), createdAt: captureReadyAt.Add(-2 * time.Second)},
		{plan: newCaptureRestartPlan(t, captureRestartPlanInput{tenantID: tenantID, spaceID: spaceID, episodeID: episodeID, recordingID: recordingID, jobID: jobID, planHandle: planOneHandle, participant: participant, digest: digestOne, attemptCount: 1, fencingGeneration: 1, captureEpoch: 1, revision: 2, trackReference: "camera-two", deadline: leaseExpiresAt}), createdAt: captureReadyAt.Add(-time.Second)},
		{plan: newCaptureRestartPlan(t, captureRestartPlanInput{tenantID: tenantID, spaceID: spaceID, episodeID: episodeID, recordingID: recordingID, jobID: jobID, planHandle: planOneHandle, participant: participant, digest: digestOne, attemptCount: 1, fencingGeneration: 1, captureEpoch: 1, revision: 3, trackReference: "camera-three", deadline: leaseExpiresAt}), createdAt: captureReadyAt.Add(500 * time.Millisecond)},
		{plan: newCaptureRestartPlan(t, captureRestartPlanInput{tenantID: tenantID, spaceID: spaceID, episodeID: episodeID, recordingID: recordingID, jobID: jobID, planHandle: planTwoHandle, participant: participant, digest: digestTwo, attemptCount: 2, fencingGeneration: 2, captureEpoch: 2, revision: 1, trackReference: "camera-four", deadline: leaseExpiresAt}), createdAt: captureReadyAt.Add(1500 * time.Millisecond)},
	}
	for _, value := range plans {
		authority := value.plan.Authority()
		cursors := value.plan.Cursors()
		if _, err := transaction.Exec(ctx, `insert into recording_capture_plans(plan_handle, revision, job_id, attempt_count, fencing_generation, capture_epoch, envelope_digest, tenant_id, space_id, episode_id, recording_id, episode_control_revision, provider_incarnation, provider_sequence, plan_schema_version, plan_bytes, plan_fingerprint, effective_deadline_at, created_at) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'capture_plan.v1', $15, $16, $17, $18)`, string(authority.PlanHandle), int64(value.plan.Revision()), jobID.Bytes(), authority.AttemptCount, authority.FencingGeneration, int64(authority.CaptureEpoch), authority.EnvelopeDigest, tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), cursors.EpisodeControlRevision, cursors.ProviderIncarnation, cursors.ProviderSequence, value.plan.CanonicalJSON(), value.plan.FingerprintBytes(), value.plan.EffectiveDeadline(), value.createdAt); err != nil {
			t.Fatalf("seed capture plan epoch %d revision %d: %v", authority.CaptureEpoch, value.plan.Revision(), err)
		}
	}

	bundles := []struct {
		id         utilities.ID
		sequence   int64
		fencing    int64
		mediaStart int64
		mediaEnd   int64
	}{
		{id: newCaptureRestartID(t), sequence: 0, fencing: 1, mediaStart: 0, mediaEnd: 1_000},
		{id: newCaptureRestartID(t), sequence: 1, fencing: 2, mediaStart: 1_000, mediaEnd: 2_500},
	}
	for _, bundle := range bundles {
		if _, err := transaction.Exec(ctx, `insert into recording_bundles(id, tenant_id, recording_id, capture_job_id, sequence_number, fencing_generation, object_key, content_type, codec, byte_size, checksum, monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis) values($1, $2, $3, $4, $5, $6, $7, 'video/webm', 'vp8', 16, $8, $9, $10, $11, $12)`, bundle.id.Bytes(), tenantID.Bytes(), recordingID.Bytes(), jobID.Bytes(), bundle.sequence, bundle.fencing, fmt.Sprintf("capture-restart/bundle-%d", bundle.sequence), bytes.Repeat([]byte{0x44}, 16), bundle.mediaStart, bundle.mediaEnd, bundle.mediaStart, bundle.mediaEnd); err != nil {
			t.Fatalf("seed bundle %d: %v", bundle.sequence, err)
		}
	}

	return captureRestartPresentationFixture{
		authority: recordingpresentation.CompletionAuthority{
			JobID: jobID, AttemptCount: 2, FencingGeneration: 2, CaptureEpoch: 2,
			EnvelopeDigest: digestTwo, LeaseToken: "lease-two", LeaseOwner: "worker-two",
		},
		captureReadyAt: captureReadyAt,
	}
}

type captureRestartPlanInput struct {
	tenantID          utilities.ID
	spaceID           utilities.ID
	episodeID         utilities.ID
	recordingID       utilities.ID
	jobID             utilities.ID
	planHandle        utilities.ID
	participant       captureplan.ParticipantSnapshot
	digest            []byte
	attemptCount      int
	fencingGeneration int64
	captureEpoch      int64
	revision          int64
	trackReference    string
	deadline          time.Time
}

func newCaptureRestartPlan(t *testing.T, input captureRestartPlanInput) captureplan.Plan {
	t.Helper()
	plan, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: captureplan.PlanAuthority{
			PlanHandle: captureplan.PlanHandle(input.planHandle.String()), TenantID: input.tenantID,
			SpaceID: input.spaceID, EpisodeID: input.episodeID, RecordingID: input.recordingID,
			JobID: input.jobID, AttemptCount: input.attemptCount, FencingGeneration: input.fencingGeneration,
			CaptureEpoch: captureplan.CaptureEpoch(input.captureEpoch), EnvelopeDigest: input.digest,
		},
		Revision:      captureplan.PlanRevision(input.revision),
		Cursors:       captureplan.PlanCursors{EpisodeControlRevision: 0, ProviderIncarnation: 1, ProviderSequence: input.revision},
		LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 1,
		InputBitrateBPS: 1_000_000, EffectiveDeadline: input.deadline, StopState: captureplan.StopStateRunning,
		Participants: []captureplan.ParticipantSnapshot{input.participant},
		Tracks: []captureplan.TrackSnapshot{{
			ParticipantID: input.participant.ID, ParticipantGeneration: input.participant.Generation,
			Source: captureplane.TrackSourceCamera, Kind: captureplane.TrackKindVideo,
			OwnerReference:       captureplane.ProviderReference("connection"),
			TrackReference:       captureplane.ProviderReference(input.trackReference),
			OwnerMID:             captureplane.ProviderReference("0"),
			PublicationReference: captureplan.PublicationReference(input.trackReference),
			RequestedLayer:       captureplane.TrackLayerAuto,
		}},
	})
	if err != nil {
		t.Fatalf("build capture plan epoch %d revision %d: %v", input.captureEpoch, input.revision, err)
	}
	return plan
}

func newCaptureRestartID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("generate fixture ID: %v", err)
	}
	return id
}
