package postgres_test

import (
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

const (
	syntheticCaptureLeaseToken = "lease-token-AbCdEf0123456789"
	syntheticCaptureCaption    = "Dr Synthetic Person says the quarterly numbers are private"
)

// The fixture fails attempt 1 with a provider close error, then claims a
// completion-only attempt 2. Completing it clears the job's own error, so the
// attempt failure row is the only record of what attempt 1 reported.
func TestFailedCaptureAttemptStaysReadableAfterRetrySucceeds(t *testing.T) {
	ctx := t.Context()
	tx, f, lease := newStoppedCompletionFixture(t)
	defer tx.Rollback(ctx)
	repository := postgres.NewRecordingPipelineRepository(sqlc.New(tx))

	completed, err := repository.CompleteCapture(ctx, lease, f.recordingID)
	if err != nil || completed.State != recordingpipeline.JobStateSucceeded {
		t.Fatalf("complete retried attempt: state=%s err=%v", completed.State, err)
	}
	var jobErrorCode, jobErrorDetail *string
	if err := tx.QueryRow(ctx, `select error_code, error_detail from recording_jobs where id=$1`, f.jobID.Bytes()).Scan(&jobErrorCode, &jobErrorDetail); err != nil {
		t.Fatal(err)
	}
	if jobErrorCode != nil || jobErrorDetail != nil {
		t.Fatalf("succeeded job must clear its own error, got code=%v detail=%v", jobErrorCode, jobErrorDetail)
	}

	rows, err := tx.Query(ctx, `select attempt_count, fencing_generation, kind, error_code, error_detail, lease_owner, failed_at is not null
		from recording_job_attempt_failures where job_id=$1 order by attempt_count`, f.jobID.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var attempt int
		var generation int64
		var kind, code, detail, owner string
		var hasTime bool
		if err := rows.Scan(&attempt, &generation, &kind, &code, &detail, &owner, &hasTime); err != nil {
			t.Fatal(err)
		}
		count++
		for _, secret := range []string{syntheticCaptureLeaseToken, "X-Amz", "objects.example.test", "deadbeef", "Synthetic", "quarterly"} {
			if strings.Contains(detail, secret) {
				t.Fatalf("stored detail kept %q: %s", secret, detail)
			}
		}
		if attempt != 1 || generation != 1 || kind != "capture" || code != "capture_attempt_failed" ||
			detail != "recorder control-plane request failed with HTTP status 502 code recording.capture_provider_failed: [redacted]" || owner != f.leaseOwner || !hasTime {
			t.Fatalf("attempt failure lost detail: attempt=%d generation=%d kind=%s code=%s detail=%q owner=%q time=%v",
				attempt, generation, kind, code, detail, owner, hasTime)
		}
	}
	if err := rows.Err(); err != nil || count != 1 {
		t.Fatalf("want exactly the failed attempt: count=%d err=%v", count, err)
	}
}
