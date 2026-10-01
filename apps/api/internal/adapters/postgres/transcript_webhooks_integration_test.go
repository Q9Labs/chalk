package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTranscriptCompletionProducesReadyDocumentWebhook(t *testing.T) {
	ctx, tx, repository, transcriptID, jobID := newTranscriptClaimFixture(t, "transcription_finalize", "verifying", false)
	seedClaimableTranscriptChunk(t, ctx, tx, transcriptID)
	var tenantID string
	if err := tx.QueryRow(ctx, `select tenant_id::text from transcriptions where id=$1`, uuid(transcriptID)).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	subscribeArtifactWebhooksTx(t, ctx, tx, idFromString(t, tenantID))
	now := time.Now()
	token := "finalizer-webhook-token"
	if _, err := tx.Exec(ctx, `update artifact_jobs set state='leased',attempt_count=1,lease_owner='webhook-test',lease_token_hash=$2,lease_expires_at=$3 where id=$1`, uuid(jobID), leaseHash(token), now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	input := transcripts.FinalizerCompleteInput{
		JobID: jobID, Attempt: 1, LeaseOwner: "webhook-test", LeaseToken: token, Now: now,
		Provider: "deepinfra", Model: "openai/whisper-large-v3-turbo", Languages: []string{"en"},
		ArtifactSHA256: make([]byte, 32), ArtifactSize: 128, ArtifactContentType: "application/json",
	}
	ready, err := repository.CompleteFinalizer(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if ready.Status != transcripts.StatusComplete || ready.ArtifactKey == nil {
		t.Fatal("completion did not make the document ready")
	}
	if _, err := repository.CompleteFinalizer(ctx, input); !errors.Is(err, transcripts.ErrStaleLease) {
		t.Fatalf("duplicate completion error=%v", err)
	}
	assertTranscriptWebhookCount(t, ctx, tx, transcriptID, "transcript.completed", 1)
}

func idFromString(t *testing.T, value string) utilities.ID {
	t.Helper()
	result, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertTranscriptWebhookCount(t *testing.T, ctx context.Context, tx pgx.Tx, transcriptID utilities.ID, event string, expected int) {
	t.Helper()
	var count int
	if err := tx.QueryRow(ctx, `select count(*) from webhook_events where resource_id=$1 and event_name=$2`, uuid(transcriptID), event).Scan(&count); err != nil || count != expected {
		t.Fatalf("%s count=%d expected=%d error=%v", event, count, expected, err)
	}
}

func TestTranscriptTerminalFailuresPublishButRetriesDoNot(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		t.Run(map[bool]string{false: "retryable", true: "terminal"}[terminal], func(t *testing.T) {
			ctx, tx, repository, transcriptID, jobID := newTranscriptClaimFixture(t, "transcription_finalize", "verifying", false)
			var tenantID string
			if err := tx.QueryRow(ctx, `select tenant_id::text from transcriptions where id=$1`, uuid(transcriptID)).Scan(&tenantID); err != nil {
				t.Fatal(err)
			}
			subscribeArtifactWebhooksTx(t, ctx, tx, idFromString(t, tenantID))
			now := time.Now()
			if _, err := tx.Exec(ctx, `update artifact_jobs set state='leased',attempt_count=1,lease_owner='webhook-test',lease_token_hash=$2,lease_expires_at=$3 where id=$1`, uuid(jobID), leaseHash("retry-token"), now.Add(time.Minute)); err != nil {
				t.Fatal(err)
			}
			_, err := repository.Retry(ctx, transcripts.RetryInput{LeaseInput: transcripts.LeaseInput{JobID: jobID, Attempt: 1, LeaseOwner: "webhook-test", LeaseToken: "retry-token", Now: now}, AvailableAt: now.Add(time.Minute), ErrorCode: "provider_failed", Terminal: terminal})
			if err != nil {
				t.Fatal(err)
			}
			expected := 0
			if terminal {
				expected = 1
			}
			assertTranscriptWebhookCount(t, ctx, tx, transcriptID, "transcript.failed", expected)
			row, err := sqlc.New(tx).GetArtifactJob(ctx, uuid(jobID))
			if err != nil {
				t.Fatal(err)
			}
			if terminal && row.State != "dead_letter" {
				t.Fatalf("terminal job state=%s", row.State)
			}
		})
	}
}

func TestExpiredFinalizerPublishesFailureEvenWithoutNextJob(t *testing.T) {
	ctx, tx, repository, transcriptID, _ := newTranscriptClaimFixture(t, "transcription_finalize", "verifying", true)
	var tenantID string
	if err := tx.QueryRow(ctx, `select tenant_id::text from transcriptions where id=$1`, uuid(transcriptID)).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	subscribeArtifactWebhooksTx(t, ctx, tx, idFromString(t, tenantID))
	for range 2 {
		_, err := repository.ClaimFinalizer(ctx, transcripts.FinalizerClaimInput{Owner: "webhook-test", LeaseDuration: time.Minute, Now: time.Now()})
		if !errors.Is(err, transcripts.ErrNoClaimableJob) {
			t.Fatalf("claim error=%v", err)
		}
	}
	assertTranscriptWebhookCount(t, ctx, tx, transcriptID, "transcript.failed", 1)
}
