package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTranscriptRequestEnforcesFrozenEpisodeTranscriptionPolicy(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv(config.DatabaseURL)
	}
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open transcription policy database: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping transcription policy database: %v", err)
	}
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire transcription policy connection: %v", err)
	}
	defer connection.Release()

	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	defer cleanupTranscriptPolicyFixture(t, ctx, connection, tenantID)
	repository := NewTranscriptRepositoryWithPool(sqlc.New(connection), connection)

	disabledRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "disabled", false)
	assertDisabledTranscriptRequest(t, ctx, repository, tenantID, disabledRecording)

	legacyRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "", true)
	assertDisabledTranscriptRequest(t, ctx, repository, tenantID, legacyRecording)

	for _, mode := range []string{"on_demand", "automatic"} {
		recordingID := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, mode, false)
		if _, err := connection.Exec(ctx, `update recordings set status = 'pending', completed_at = null where id = $1`, recordingID.Bytes()); err != nil {
			t.Fatalf("mark %s recording pending without MP4: %v", mode, err)
		}
		insertTranscriptSourceFixture(t, ctx, connection, tenantID, recordingID)
		input := transcriptPolicyRequestInput(t, tenantID, recordingID, "allowed-"+mode)
		if mode == "automatic" {
			// Omitting a language requests provider detection and must persist an
			// empty array rather than a SQL NULL.
			input.Languages = nil
		}
		transcript, job, err := repository.Request(ctx, input)
		if err != nil {
			t.Fatalf("%s request: %v", mode, err)
		}
		if transcript.RecordingID != recordingID || job.RecordingID != recordingID {
			t.Fatalf("%s result recording ids = transcript %s, job %s; want %s", mode, transcript.RecordingID, job.RecordingID, recordingID)
		}
		if mode == "automatic" {
			assertRequestedTranscriptHasEmptyLanguages(t, ctx, connection, transcript.ID)
		}
		assertTranscriptArtifactCounts(t, ctx, connection, recordingID, 1, 1)
	}

	expiredRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
	insertTranscriptSourceFixture(t, ctx, connection, tenantID, expiredRecording)
	if _, err := connection.Exec(ctx, `update recordings set status = 'pending', completed_at = null where id = $1`, expiredRecording.Bytes()); err != nil {
		t.Fatalf("mark expired-source recording pending: %v", err)
	}
	if _, err := connection.Exec(ctx, `update recording_transcription_sources set committed_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where recording_id = $1`, expiredRecording.Bytes()); err != nil {
		t.Fatalf("expire transcription source: %v", err)
	}
	if _, _, err := repository.Request(ctx, transcriptPolicyRequestInput(t, tenantID, expiredRecording, "expired-no-mp4")); !errors.Is(err, transcripts.ErrSourceExpired) {
		t.Fatalf("expired no-MP4 request error = %v, want ErrSourceExpired", err)
	}
	assertTranscriptArtifactCounts(t, ctx, connection, expiredRecording, 0, 0)

	replayRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "disabled", false)
	replayTranscriptID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	replayJobID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	const replayKey = "disabled-replay-0001"
	if _, err := connection.Exec(ctx, `
insert into transcriptions (id, tenant_id, recording_id, space_id, episode_id, status, languages)
select $1, tenant_id, id, space_id, episode_id, 'preparing', array['en']::text[]
from recordings where tenant_id = $2 and id = $3`, replayTranscriptID.Bytes(), tenantID.Bytes(), replayRecording.Bytes()); err != nil {
		t.Fatalf("seed replay transcript: %v", err)
	}
	if _, err := connection.Exec(ctx, `
insert into artifact_jobs (id, idempotency_key, tenant_id, episode_id, recording_id, transcript_id,
    artifact_kind, payload_schema_version, state, priority, available_at, attempt_count, attempt_limit)
select $1, $2, tenant_id, episode_id, id, $3, 'transcription_chunk', 1, 'pending', 0, now(), 0, 4
from recordings where tenant_id = $4 and id = $5`, replayJobID.Bytes(), replayKey+"-0", replayTranscriptID.Bytes(), tenantID.Bytes(), replayRecording.Bytes()); err != nil {
		t.Fatalf("seed replay job: %v", err)
	}
	replayedTranscript, replayedJob, err := repository.Request(ctx, transcriptPolicyRequestInput(t, tenantID, replayRecording, replayKey))
	if err != nil {
		t.Fatalf("disabled idempotent replay: %v", err)
	}
	if replayedTranscript.ID != replayTranscriptID || replayedJob.ID != replayJobID {
		t.Fatalf("replayed result = transcript %s, job %s; want %s, %s", replayedTranscript.ID, replayedJob.ID, replayTranscriptID, replayJobID)
	}
	assertTranscriptArtifactCounts(t, ctx, connection, replayRecording, 1, 1)
}

func TestRecordingArtifactStateUsesFrozenEpisodeTranscriptionPolicy(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv(config.DatabaseURL)
	}
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open recording artifact state database: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping recording artifact state database: %v", err)
	}
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire recording artifact state connection: %v", err)
	}
	defer connection.Release()

	tenantID := mustTenantPolicyTestID(t)
	defer cleanupTranscriptPolicyFixture(t, ctx, connection, tenantID)
	onDemandRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
	disabledRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "disabled", false)
	legacyRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "", true)
	failedRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "automatic", false)
	readyRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
	expiredRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
	noneRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "automatic", false)
	emptyRecording := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "automatic", false)
	for _, recordingID := range []utilities.ID{onDemandRecording, failedRecording, readyRecording, expiredRecording, noneRecording, emptyRecording} {
		if _, err := connection.Exec(ctx, `update recordings set status = 'pending', completed_at = null where id = $1`, recordingID.Bytes()); err != nil {
			t.Fatalf("mark recording %s pending: %v", recordingID, err)
		}
	}
	for _, recordingID := range []utilities.ID{onDemandRecording, failedRecording, noneRecording, emptyRecording} {
		insertTranscriptPolicyCaptureCompleteFixture(t, ctx, connection, tenantID, recordingID)
	}
	insertTranscriptPolicyPreparationJobFixture(t, ctx, connection, tenantID, onDemandRecording, "pending")
	insertTranscriptPolicyPreparationJobFixture(t, ctx, connection, tenantID, failedRecording, "terminal_failure")
	insertTranscriptPolicyPreparationJobFixture(t, ctx, connection, tenantID, emptyRecording, "succeeded")
	exportJobID := insertTranscriptPolicyExportJobFixture(t, ctx, connection, tenantID, onDemandRecording)
	insertTranscriptSourceFixture(t, ctx, connection, tenantID, readyRecording)
	insertTranscriptPolicyPreparationJobFixture(t, ctx, connection, tenantID, readyRecording, "terminal_failure")
	insertTranscriptSourceFixture(t, ctx, connection, tenantID, expiredRecording)
	if _, err := connection.Exec(ctx, `update recording_transcription_sources set committed_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where recording_id = $1`, expiredRecording.Bytes()); err != nil {
		t.Fatalf("expire prepared source: %v", err)
	}
	for _, change := range []struct {
		recordingID utilities.ID
		currentMode string
	}{
		{recordingID: onDemandRecording, currentMode: "disabled"},
		{recordingID: disabledRecording, currentMode: "automatic"},
		{recordingID: legacyRecording, currentMode: "on_demand"},
	} {
		if _, err := connection.Exec(ctx, `
update spaces set transcription_policy = $1
where id = (select space_id from recordings where id = $2)`, change.currentMode, change.recordingID.Bytes()); err != nil {
			t.Fatalf("change current Space transcription policy for %s: %v", change.recordingID, err)
		}
	}

	states, err := NewRecordingPipelineRepositoryWithPool(pool).GetArtifactStates(ctx, tenantID, []utilities.ID{onDemandRecording, disabledRecording, legacyRecording, failedRecording, readyRecording, expiredRecording, noneRecording, emptyRecording})
	if err != nil {
		t.Fatalf("get batched recording artifact states: %v", err)
	}
	for recordingID, want := range map[utilities.ID]artifactpolicy.TranscriptionMode{
		onDemandRecording: artifactpolicy.TranscriptionOnDemand,
		disabledRecording: artifactpolicy.TranscriptionDisabled,
		legacyRecording:   artifactpolicy.TranscriptionDisabled,
	} {
		state, ok := states[recordingID]
		if !ok || state.TranscriptionPolicy != want {
			t.Fatalf("recording %s frozen transcription policy=%q present=%t, want %q", recordingID, state.TranscriptionPolicy, ok, want)
		}
	}
	for recordingID, want := range map[utilities.ID]recordingpipeline.TranscriptionPreparationStatus{
		onDemandRecording: recordingpipeline.TranscriptionPreparationPending,
		failedRecording:   recordingpipeline.TranscriptionPreparationFailed,
		readyRecording:    recordingpipeline.TranscriptionPreparationReady,
		expiredRecording:  recordingpipeline.TranscriptionPreparationExpired,
		noneRecording:     recordingpipeline.TranscriptionPreparationNone,
		emptyRecording:    recordingpipeline.TranscriptionPreparationNone,
		disabledRecording: recordingpipeline.TranscriptionPreparationNone,
	} {
		state := states[recordingID]
		if state.TranscriptionPreparationStatus != want {
			t.Fatalf("recording %s preparation status = %q, want %q", recordingID, state.TranscriptionPreparationStatus, want)
		}
		if recordingID == failedRecording && (state.SourceStatus != recordingpipeline.SourceStatusAvailable || state.ExportStatus != recordingpipeline.ExportStatusNone) {
			t.Fatalf("failed audio preparation changed Capture or Video Export state: %+v", state)
		}
	}
	if exportState := states[onDemandRecording]; exportState.ExportStatus != recordingpipeline.ExportStatusPending || exportState.ExportJobID == nil || *exportState.ExportJobID != exportJobID {
		t.Fatalf("recording with on-request Export job = %+v, want pending with its own job ID", exportState)
	}
	if noExportState := states[noneRecording]; noExportState.ExportStatus != recordingpipeline.ExportStatusNone || noExportState.ExportJobID != nil {
		t.Fatalf("recording without Export job inherited another recording's state: %+v", noExportState)
	}
	if _, err := connection.Exec(ctx, `update recording_jobs set state = 'terminal_failure', error_code = 'render_failure_probe' where id = $1`, exportJobID.Bytes()); err != nil {
		t.Fatalf("mark on-request Export failed: %v", err)
	}
	exportStates, err := NewRecordingPipelineRepositoryWithPool(pool).GetArtifactStates(ctx, tenantID, []utilities.ID{onDemandRecording, noneRecording})
	if err != nil {
		t.Fatalf("get two-recording Export states: %v", err)
	}
	if failedExport := exportStates[onDemandRecording]; failedExport.ExportStatus != recordingpipeline.ExportStatusFailed || failedExport.FailureCode != "render_failure_probe" {
		t.Fatalf("failed on-request Export state = %+v", failedExport)
	}
	if noExport := exportStates[noneRecording]; noExport.ExportStatus != recordingpipeline.ExportStatusNone || noExport.ExportJobID != nil || noExport.FailureCode != "" {
		t.Fatalf("recording without Export job inherited failed Export: %+v", noExport)
	}
}

func assertDisabledTranscriptRequest(t *testing.T, ctx context.Context, repository TranscriptRepository, tenantID, recordingID utilities.ID) {
	t.Helper()
	_, _, err := repository.Request(ctx, transcriptPolicyRequestInput(t, tenantID, recordingID, "disabled-"+recordingID.String()))
	if !errors.Is(err, transcripts.ErrTranscriptionDisabled) {
		t.Fatalf("disabled request error = %v, want ErrTranscriptionDisabled", err)
	}
}

func assertRequestedTranscriptHasEmptyLanguages(t *testing.T, ctx context.Context, connection *pgxpool.Conn, transcriptID utilities.ID) {
	t.Helper()
	var languagesNull bool
	var languageCount int
	if err := connection.QueryRow(ctx, `select languages is null, cardinality(languages) from transcriptions where id = $1`, transcriptID.Bytes()).Scan(&languagesNull, &languageCount); err != nil {
		t.Fatalf("read requested transcript languages: %v", err)
	}
	if languagesNull || languageCount != 0 {
		t.Fatalf("requested transcript languages null=%t count=%d, want empty array", languagesNull, languageCount)
	}
}

func insertTranscriptPolicyFixture(t *testing.T, ctx context.Context, connection *pgxpool.Conn, tenantID utilities.ID, mode string, legacy bool) utilities.ID {
	t.Helper()
	spaceID := mustTenantPolicyTestID(t)
	episodeID := mustTenantPolicyTestID(t)
	recordingID := mustTenantPolicyTestID(t)
	if _, err := connection.Exec(ctx, `insert into tenants (id, name) values ($1, $2) on conflict (id) do nothing`, tenantID.Bytes(), "Transcript policy test"); err != nil {
		t.Fatalf("insert policy tenant: %v", err)
	}
	if _, err := connection.Exec(ctx, `insert into spaces (id, tenant_id, name, slug, media_plane, admission_policy, recording_policy, transcription_policy, default_episode_duration_seconds, maximum_episode_duration_seconds) values ($1, $2, $3, $4, 'cf_sfu', '{"mode":"open"}', 'manual', $5, 60, 60)`, spaceID.Bytes(), tenantID.Bytes(), "Transcript policy space "+spaceID.String(), "transcript-policy-"+spaceID.String(), modeOrDisabled(mode)); err != nil {
		t.Fatalf("insert policy space: %v", err)
	}
	snapshot := transcriptPolicySnapshot(mode, legacy)
	if _, err := connection.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot, started_at, ended_at) values ($1, 'ended', $2, $3, $4::jsonb, now(), now())`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes(), snapshot); err != nil {
		t.Fatalf("insert policy episode: %v", err)
	}
	if _, err := connection.Exec(ctx, `insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider, completed_at) values ($1, $2, $3, $4, 'completed', 'r2', now())`, recordingID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()); err != nil {
		t.Fatalf("insert policy recording: %v", err)
	}
	return recordingID
}

func transcriptPolicySnapshot(mode string, legacy bool) string {
	base := `{"roles":{},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":60,"maximum_episode_duration_seconds":60,"linger_window_seconds":0`
	if legacy {
		return base + `}`
	}
	providerVersion := ""
	sourceWindow := 0
	if mode != "disabled" {
		providerVersion = "provider-v1"
		sourceWindow = 3600
	}
	return fmt.Sprintf(`%s,"artifact_policy":{"schema_version":"episode_config.v2","recording":{"mode":"manual","profile":"composite_720p_v1","retention_seconds":0},"transcription":{"mode":%q,"provider_policy_version":%q,"retention_seconds":0,"source_window_seconds":%d}}}`, base, mode, providerVersion, sourceWindow)
}

func transcriptPolicyRequestInput(t *testing.T, tenantID, recordingID utilities.ID, key string) transcripts.RequestInput {
	t.Helper()
	return transcripts.RequestInput{
		TenantID: tenantID, RecordingID: recordingID, IdempotencyKey: key,
		Languages: []string{"en"}, AttemptLimit: 4, Now: time.Now(),
	}
}

func insertTranscriptSourceFixture(t *testing.T, ctx context.Context, connection *pgxpool.Conn, tenantID, recordingID utilities.ID) {
	t.Helper()
	chunkID := mustTenantPolicyTestID(t)
	digest := make([]byte, 32)
	if _, err := connection.Exec(ctx, `
insert into recording_transcription_sources (
    recording_id, tenant_id, manifest_key, manifest_sha256, manifest_size,
    manifest_content_type, schema_version, committed_at, generation,
    commit_digest, presentation_sha256, status, expires_at
) values ($1, $2, $3, $4, 1, 'application/json', 1, now(), 1, $4, $4, 'ready', now() + interval '1 hour')`,
		recordingID.Bytes(), tenantID.Bytes(), "transcription/source/"+recordingID.String()+"/manifest.json", digest); err != nil {
		t.Fatalf("insert transcription source: %v", err)
	}
	if _, err := connection.Exec(ctx, `
insert into recording_transcription_source_chunks (
    id, recording_id, tenant_id, chunk_index, generation, start_ms, end_ms,
    source_start_ms, source_end_ms, participant_ref, participant_generation,
    track_id, track_epoch, identity_kind, track_class, display_name_snapshot,
    overlap, storage_key, checksum, size, content_type
) values ($1, $2, $3, 0, 1, 0, 1000, 0, 1000, 'participant-1', 1,
    'track-1', '1', 'participant', 'microphone', 'Speaker', false, $4, $5, 1, 'audio/flac')`,
		chunkID.Bytes(), recordingID.Bytes(), tenantID.Bytes(), "transcription/source/"+recordingID.String()+"/chunk-0.flac", digest); err != nil {
		t.Fatalf("insert transcription source chunk: %v", err)
	}
}

func insertTranscriptPolicyCaptureCompleteFixture(t *testing.T, ctx context.Context, connection *pgxpool.Conn, tenantID, recordingID utilities.ID) {
	t.Helper()
	reservationID := mustTenantPolicyTestID(t)
	if _, err := connection.Exec(ctx, `
insert into recording_reservations (
    id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
    request_fingerprint, policy_snapshot_version, participant_count,
    max_duration_seconds, input_bitrate_bps, state, ends_at
)
select $1, tenant_id, space_id, episode_id, id, $2, $3,
    'episode_config.v2', 1, 60, 100000, 'released', now()
from recordings where id = $4`, reservationID.Bytes(), "preparation-"+recordingID.String(), make([]byte, 32), recordingID.Bytes()); err != nil {
		t.Fatalf("insert capture reservation: %v", err)
	}
	if _, err := connection.Exec(ctx, `
insert into recording_pipelines (recording_id, tenant_id, reservation_id, state, capture_completed_at)
values ($1, $2, $3, 'capture_complete', now())`, recordingID.Bytes(), tenantID.Bytes(), reservationID.Bytes()); err != nil {
		t.Fatalf("insert completed Capture: %v", err)
	}
}

func insertTranscriptPolicyPreparationJobFixture(t *testing.T, ctx context.Context, connection *pgxpool.Conn, tenantID, recordingID utilities.ID, state string) {
	t.Helper()
	jobID := mustTenantPolicyTestID(t)
	if _, err := connection.Exec(ctx, `
insert into recording_jobs (
    id, tenant_id, episode_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, available_at, attempt_limit
)
select $1, $2, episode_id, id, 'transcription', $3, 1, $4, now(), 4
from recordings where id = $5`, jobID.Bytes(), tenantID.Bytes(), "transcription:"+recordingID.String(), state, recordingID.Bytes()); err != nil {
		t.Fatalf("insert audio preparation job: %v", err)
	}
}

func insertTranscriptPolicyExportJobFixture(t *testing.T, ctx context.Context, connection *pgxpool.Conn, tenantID, recordingID utilities.ID) utilities.ID {
	t.Helper()
	jobID := mustTenantPolicyTestID(t)
	if _, err := connection.Exec(ctx, `
insert into recording_jobs (
    id, tenant_id, episode_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, available_at, attempt_limit
)
select $1, $2, episode_id, id, 'render', $3, 1, 'pending', now(), 4
from recordings where id = $4`, jobID.Bytes(), tenantID.Bytes(), "render:"+recordingID.String(), recordingID.Bytes()); err != nil {
		t.Fatalf("insert on-request Export job: %v", err)
	}
	return jobID
}

func assertTranscriptArtifactCounts(t *testing.T, ctx context.Context, connection *pgxpool.Conn, recordingID utilities.ID, transcriptsCount, jobsCount int) {
	t.Helper()
	var actualTranscripts, actualJobs int
	if err := connection.QueryRow(ctx, `select count(*) from transcriptions where recording_id = $1`, recordingID.Bytes()).Scan(&actualTranscripts); err != nil {
		t.Fatalf("count policy transcripts: %v", err)
	}
	if err := connection.QueryRow(ctx, `select count(*) from artifact_jobs where recording_id = $1`, recordingID.Bytes()).Scan(&actualJobs); err != nil {
		t.Fatalf("count policy jobs: %v", err)
	}
	if actualTranscripts != transcriptsCount || actualJobs != jobsCount {
		t.Fatalf("policy artifact counts = transcripts %d, jobs %d; want %d, %d", actualTranscripts, actualJobs, transcriptsCount, jobsCount)
	}
}

func cleanupTranscriptPolicyFixture(t *testing.T, ctx context.Context, connection *pgxpool.Conn, tenantID utilities.ID) {
	t.Helper()
	for _, statement := range []string{
		`delete from artifact_jobs where tenant_id = $1`,
		`delete from transcription_cleanup_jobs where tenant_id = $1`,
		`delete from transcript_chunks where tenant_id = $1`,
		`delete from recording_transcription_source_chunks where tenant_id = $1`,
		`delete from recording_transcription_sources where tenant_id = $1`,
		`delete from transcriptions where tenant_id = $1`,
		`delete from recording_jobs where tenant_id = $1`,
		`delete from recording_pipelines where tenant_id = $1`,
		`delete from recording_reservations where tenant_id = $1`,
		`delete from recordings where tenant_id = $1`,
		`delete from episodes where tenant_id = $1`,
		`delete from spaces where tenant_id = $1`,
		`delete from tenants where id = $1`,
	} {
		if _, err := connection.Exec(ctx, statement, tenantID.Bytes()); err != nil {
			t.Errorf("cleanup transcription policy fixture: %v", err)
		}
	}
}

func modeOrDisabled(mode string) string {
	if mode == "" {
		return "disabled"
	}
	return mode
}

func mustTenantPolicyTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
