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
	"github.com/q9labs/chalk/apps/api/internal/config"
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
		transcript, job, err := repository.Request(ctx, transcriptPolicyRequestInput(t, tenantID, recordingID, "allowed-"+mode))
		if err != nil {
			t.Fatalf("%s request: %v", mode, err)
		}
		if transcript.RecordingID != recordingID || job.RecordingID != recordingID {
			t.Fatalf("%s result recording ids = transcript %s, job %s; want %s", mode, transcript.RecordingID, job.RecordingID, recordingID)
		}
		assertTranscriptArtifactCounts(t, ctx, connection, recordingID, 1, 1)
	}

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
select $1, tenant_id, id, space_id, episode_id, 'preparing', '{}'::text[]
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

func assertDisabledTranscriptRequest(t *testing.T, ctx context.Context, repository TranscriptRepository, tenantID, recordingID utilities.ID) {
	t.Helper()
	_, _, err := repository.Request(ctx, transcriptPolicyRequestInput(t, tenantID, recordingID, "disabled-"+recordingID.String()))
	if !errors.Is(err, transcripts.ErrTranscriptionDisabled) {
		t.Fatalf("disabled request error = %v, want ErrTranscriptionDisabled", err)
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
	chunkID := mustTenantPolicyTestID(t)
	return transcripts.RequestInput{
		TenantID:            tenantID,
		RecordingID:         recordingID,
		IdempotencyKey:      key,
		ManifestKey:         "manifest.json",
		ManifestSHA256:      make([]byte, 32),
		ManifestSize:        1,
		ManifestContentType: "application/json",
		Languages:           []string{"en"},
		Chunks: []transcripts.ChunkInput{{
			ID: chunkID, Index: 0, Generation: 1, StartMS: 0, EndMS: 1000,
			IdentityKind: "unknown", TrackClass: "microphone", StorageKey: "source.wav",
			Checksum: make([]byte, 32), Size: 1, ContentType: "audio/wav",
		}},
		AttemptLimit: 4,
	}
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
		`delete from transcript_chunks where tenant_id = $1`,
		`delete from transcriptions where tenant_id = $1`,
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
