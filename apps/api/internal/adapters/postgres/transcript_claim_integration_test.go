package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestClaimFinalizerCommitsExpiredTerminalLeaseWithoutCandidate(t *testing.T) {
	ctx, tx, repository, transcriptID, jobID := newTranscriptClaimFixture(t, "transcription_finalize", "verifying", true)
	_, err := repository.ClaimFinalizer(ctx, transcripts.FinalizerClaimInput{Owner: "claim-test", LeaseDuration: time.Minute, Now: time.Now()})
	if !errors.Is(err, transcripts.ErrNoClaimableJob) {
		t.Fatalf("claim finalizer error = %v, want no claimable job", err)
	}
	assertExpiredTranscriptClaim(t, ctx, tx, transcriptID, jobID)
}

func TestClaimArtifactCommitsExpiredTerminalLeaseWithoutCandidate(t *testing.T) {
	ctx, tx, repository, transcriptID, jobID := newTranscriptClaimFixture(t, "transcription_chunk", "transcribing", true)
	_, err := repository.Claim(ctx, transcripts.ClaimInput{Owner: "claim-test", LeaseDuration: time.Minute, Now: time.Now()})
	if !errors.Is(err, transcripts.ErrNoClaimableJob) {
		t.Fatalf("claim chunk error = %v, want no claimable job", err)
	}
	assertExpiredTranscriptClaim(t, ctx, tx, transcriptID, jobID)
}

func TestClaimCleanupCommitsExpiredTerminalLeaseWithoutCandidate(t *testing.T) {
	ctx, tx, repository, transcriptID, _ := newTranscriptClaimFixture(t, "transcription_finalize", "verifying", false)
	jobID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into transcription_cleanup_jobs (
		id, tenant_id, recording_id, transcript_id, object_key, object_kind,
		due_at, state, attempt_count, attempt_limit, lease_token_hash,
		lease_owner, lease_expires_at
	) select $1, tenant_id, recording_id, id, $2, 'temp_result', now(),
		'leased', 4, 4, $3, 'expired-worker', $4
	from transcriptions where id = $5`, jobID.Bytes(), "claims/cleanup.json", make([]byte, 32), time.Now().Add(-time.Minute), transcriptID.Bytes()); err != nil {
		t.Fatalf("seed cleanup job: %v", err)
	}
	_, _, err = repository.ClaimCleanup(ctx, transcripts.CleanupClaimInput{Owner: "claim-test", LeaseDuration: time.Minute, Now: time.Now()})
	if !errors.Is(err, transcripts.ErrNoClaimableJob) {
		t.Fatalf("claim cleanup error = %v, want no claimable job", err)
	}
	var state string
	var code *string
	var leaseExpiresAt *time.Time
	if err := tx.QueryRow(ctx, `select state, error_code, lease_expires_at from transcription_cleanup_jobs where id = $1`, jobID.Bytes()).Scan(&state, &code, &leaseExpiresAt); err != nil {
		t.Fatalf("read expired cleanup job: %v", err)
	}
	if state != "dead_letter" || code == nil || *code != "lease_expired" || leaseExpiresAt != nil {
		t.Fatalf("expired cleanup claim = state %v code %v lease %v", state, code, leaseExpiresAt)
	}
}

func TestClaimFinalizerStillLeasesAvailableJob(t *testing.T) {
	ctx, tx, repository, transcriptID, jobID := newTranscriptClaimFixture(t, "transcription_finalize", "verifying", false)
	seedClaimableTranscriptChunk(t, ctx, tx, transcriptID)
	assignment, err := repository.ClaimFinalizer(ctx, transcripts.FinalizerClaimInput{Owner: "claim-test", LeaseDuration: time.Minute, Now: time.Now()})
	if err != nil {
		t.Fatalf("claim available finalizer: %v", err)
	}
	if assignment.Job.ID != jobID || assignment.Job.Attempt != 1 || len(assignment.Chunks) != 1 {
		t.Fatalf("claimed finalizer = job %s attempt %d chunks %d, want %s attempt 1 chunk 1", assignment.Job.ID, assignment.Job.Attempt, len(assignment.Chunks), jobID)
	}
	var jobState, transcriptState, owner string
	var leaseExpiresAt time.Time
	if err := tx.QueryRow(ctx, `select state, lease_owner, lease_expires_at from artifact_jobs where id = $1`, jobID.Bytes()).Scan(&jobState, &owner, &leaseExpiresAt); err != nil {
		t.Fatalf("read claimed finalizer: %v", err)
	}
	if err := tx.QueryRow(ctx, `select status from transcriptions where id = $1`, transcriptID.Bytes()).Scan(&transcriptState); err != nil {
		t.Fatalf("read claimed Transcript: %v", err)
	}
	if jobState != "leased" || owner != "claim-test" || !leaseExpiresAt.After(time.Now()) || transcriptState != "verifying" {
		t.Fatalf("normal claim state = job %q owner %q expiry %s Transcript %q", jobState, owner, leaseExpiresAt, transcriptState)
	}
}

func TestClaimFinalizerCommitsCancellationForTerminalTranscript(t *testing.T) {
	ctx, tx, repository, _, jobID := newTranscriptClaimFixture(t, "transcription_finalize", "terminal_failure", false)
	_, err := repository.ClaimFinalizer(ctx, transcripts.FinalizerClaimInput{Owner: "claim-test", LeaseDuration: time.Minute, Now: time.Now()})
	if !errors.Is(err, transcripts.ErrStaleLease) {
		t.Fatalf("claim terminal Transcript error = %v, want stale lease", err)
	}
	var state, code string
	if err := tx.QueryRow(ctx, `select state, error_code from artifact_jobs where id = $1`, jobID.Bytes()).Scan(&state, &code); err != nil {
		t.Fatalf("read cancelled finalizer: %v", err)
	}
	if state != "cancelled" || code != "transcript_not_claimable" {
		t.Fatalf("terminal Transcript claim = job %q code %q, want cancelled/transcript_not_claimable", state, code)
	}
}

func newTranscriptClaimFixture(t *testing.T, kind, transcriptState string, expired bool) (context.Context, pgx.Tx, TranscriptRepository, utilities.ID, utilities.ID) {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv(config.DatabaseURL)
	}
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open transcript claim database: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping transcript claim database: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin transcript claim fixture: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	newID := func() utilities.ID {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	tenantID, spaceID, episodeID, recordingID, transcriptID, jobID := newID(), newID(), newID(), newID(), newID(), newID()
	for _, seed := range []struct {
		name  string
		query string
		args  []any
	}{
		{"tenant", `insert into tenants (id, name) values ($1, 'Transcript claim test')`, []any{tenantID.Bytes()}},
		{"space", `insert into spaces (id, tenant_id, name, slug, media_plane) values ($1, $2, 'Transcript claim test', $3, 'cf_sfu')`, []any{spaceID.Bytes(), tenantID.Bytes(), "transcript-claim-" + spaceID.String()}},
		{"episode", `insert into episodes (id, status, space_id, tenant_id, config_snapshot, started_at, ended_at) values ($1, 'ended', $2, $3, '{"roles":{},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":60,"maximum_episode_duration_seconds":60,"linger_window_seconds":0}'::jsonb, now(), now())`, []any{episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()}},
		{"recording", `insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider, completed_at) values ($1, $2, $3, $4, 'completed', 'r2', now())`, []any{recordingID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()}},
		{"Transcript", `insert into transcriptions (id, tenant_id, recording_id, space_id, episode_id, status, languages) values ($1, $2, $3, $4, $5, $6, array['en']::text[])`, []any{transcriptID.Bytes(), tenantID.Bytes(), recordingID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), transcriptState}},
	} {
		if _, err := tx.Exec(ctx, seed.query, seed.args...); err != nil {
			t.Fatalf("seed %s: %v", seed.name, err)
		}
	}
	var leaseHash []byte
	var leaseOwner any
	var leaseExpiresAt any
	attemptCount := 0
	jobState := "pending"
	if expired {
		leaseHash = make([]byte, 32)
		leaseOwner = "expired-worker"
		leaseExpiresAt = time.Now().Add(-time.Minute)
		attemptCount = 4
		jobState = "leased"
	}
	if _, err := tx.Exec(ctx, `insert into artifact_jobs (
		id, idempotency_key, tenant_id, episode_id, recording_id, transcript_id, artifact_kind,
		payload_schema_version, state, available_at, attempt_count, attempt_limit,
		lease_token_hash, lease_owner, lease_expires_at
	) values ($1, $2, $3, $4, $5, $6, $7, 1, $8, now(), $9, 4, $10, $11, $12)`,
		jobID.Bytes(), "transcript-claim-"+jobID.String(), tenantID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), transcriptID.Bytes(), kind,
		jobState, attemptCount, leaseHash, leaseOwner, leaseExpiresAt); err != nil {
		t.Fatalf("seed %s job: %v", kind, err)
	}
	return ctx, tx, NewTranscriptRepositoryWithPool(sqlc.New(tx), tx), transcriptID, jobID
}

func assertExpiredTranscriptClaim(t *testing.T, ctx context.Context, tx pgx.Tx, transcriptID, jobID utilities.ID) {
	t.Helper()
	var state, transcriptState string
	var code *string
	var leaseExpiresAt, terminalAt *time.Time
	if err := tx.QueryRow(ctx, `select state, error_code, lease_expires_at, terminal_at from artifact_jobs where id = $1`, jobID.Bytes()).Scan(&state, &code, &leaseExpiresAt, &terminalAt); err != nil {
		t.Fatalf("read expired claim: %v", err)
	}
	if err := tx.QueryRow(ctx, `select status from transcriptions where id = $1`, transcriptID.Bytes()).Scan(&transcriptState); err != nil {
		t.Fatalf("read expired Transcript: %v", err)
	}
	if state != "dead_letter" || code == nil || *code != "lease_expired" || leaseExpiresAt != nil || terminalAt == nil || transcriptState != "terminal_failure" {
		t.Fatalf("expired claim = job %q code %v lease %v terminal %v Transcript %q", state, code, leaseExpiresAt, terminalAt, transcriptState)
	}
}

func seedClaimableTranscriptChunk(t *testing.T, ctx context.Context, tx pgx.Tx, transcriptID utilities.ID) {
	t.Helper()
	newID := func() utilities.ID {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	chunkID, attemptID, resultID := newID(), newID(), newID()
	digest := make([]byte, 32)
	if _, err := tx.Exec(ctx, `insert into transcript_chunks (
		id, transcript_id, tenant_id, chunk_index, generation, start_ms, end_ms,
		storage_key, result_key, checksum, size, content_type
	) select $1, id, tenant_id, 0, 1, 0, 1000, $2, $3, $4, 1, 'audio/flac'
	from transcriptions where id = $5`, chunkID.Bytes(), "claims/source.flac", "claims/result.json", digest, transcriptID.Bytes()); err != nil {
		t.Fatalf("seed Transcript chunk: %v", err)
	}
	if _, err := tx.Exec(ctx, `insert into transcription_attempts (
		id, transcript_id, chunk_id, generation, attempt, provider, model, provider_version, state
	) values ($1, $2, $3, 1, 1, 'test-provider', 'test-model', 'v1', 'accepted')`, attemptID.Bytes(), transcriptID.Bytes(), chunkID.Bytes()); err != nil {
		t.Fatalf("seed Transcript attempt: %v", err)
	}
	if _, err := tx.Exec(ctx, `insert into transcription_chunk_results (
		id, chunk_id, generation, attempt_id, provider, model, provider_version,
		result_key, result_sha256, result_size, result_content_type
	) values ($1, $2, 1, $3, 'test-provider', 'test-model', 'v1', $4, $5, 1, 'application/json')`, resultID.Bytes(), chunkID.Bytes(), attemptID.Bytes(), "claims/result.json", digest); err != nil {
		t.Fatalf("seed Transcript chunk result: %v", err)
	}
}
