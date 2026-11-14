package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// These tests pin rules of tools/formal/recording-pipeline (OnlyLeaseHolderWrites,
// SegmentsFrozenAtCompletion) on the real SQL, so a loosened guard fails here as well as in the model.

func TestRecordingBundleWriteNeedsLiveLeaseOfRunningCapture(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		setup string
		want  error
	}{
		{name: "live lease writes"},
		{name: "expired lease is refused", setup: `update recording_jobs set lease_expires_at = now() - interval '1 second' where id = $1`, want: recordingpipeline.ErrJobNotFound},
		{name: "completed capture takes no more segments", setup: `update recording_jobs set state = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null, terminal_at = now() where id = $1`, want: recordingpipeline.ErrJobNotFound},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.Background()
			tx, f := newAllocationCleanupFixture(t, false, "capture")
			defer tx.Rollback(ctx)
			if scenario.setup != "" {
				execCleanupFixture(t, tx, scenario.setup, f.jobID.Bytes())
			}
			var tenant [16]byte
			if err := tx.QueryRow(ctx, `select tenant_id from recording_jobs where id = $1`, f.jobID.Bytes()).Scan(&tenant); err != nil {
				t.Fatal(err)
			}
			tenantID := utilities.IDFromBytes(tenant)
			repository := postgres.NewRecordingPipelineRepository(sqlc.New(tx))
			id, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			segmentPath := "tenants/fixture/recordings/" + f.recordingID.String() + "/capture/1/bundles/7"
			_, err = repository.InsertBundle(ctx, recordingpipeline.BundleInput{
				ID: id, TenantID: tenantID, RecordingID: f.recordingID, CaptureJobID: f.jobID,
				SequenceNumber: 7, FencingGeneration: 1, AttemptCount: 1,
				LeaseToken: f.leaseToken, LeaseOwner: f.leaseOwner, CaptureEpoch: f.captureEpoch, EnvelopeDigest: f.digest,
				ObjectKey: segmentPath, ContentType: "application/vnd.chalk.recording-bundle+json",
				Codec: "opus", ByteSize: 1, Checksum: f.digest, MonotonicEndMillis: 1000, MediaEndMillis: 1000,
			})
			if !errors.Is(err, scenario.want) {
				t.Fatalf("insert bundle: err=%v want=%v", err, scenario.want)
			}
		})
	}
}

// NoLeaseSteal: a second worker cannot claim a capture job whose lease is live.
func TestRecordingClaimDoesNotStealLiveLease(t *testing.T) {
	tx, repository, _ := newCaptureRetryFixture(t)
	defer tx.Rollback(context.Background())
	first, err := repository.Claim(t.Context(), recordingpipeline.ClaimInput{ClaimRequestID: newCaptureRetryID(t), Kind: recordingpipeline.JobKindCapture, Owner: "worker-a", LeaseToken: "lease-a", LeaseFor: time.Minute})
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	second, err := repository.Claim(t.Context(), recordingpipeline.ClaimInput{ClaimRequestID: newCaptureRetryID(t), Kind: recordingpipeline.JobKindCapture, Owner: "worker-b", LeaseToken: "lease-b", LeaseFor: time.Minute})
	if !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("second claim of job %s took job %s from its live lease: err=%v", first.ID, second.ID, err)
	}
}

// NoFreshCaptureAfterStop: once a stop is requested, a capture that never started is not claimed.
func TestRecordingClaimStartsNoFreshCaptureAfterStop(t *testing.T) {
	tx, repository, identity := newCaptureRetryFixture(t)
	defer tx.Rollback(context.Background())
	if _, err := repository.RequestStop(t.Context(), identity.TenantID, identity.EpisodeID, identity.RecordingID, newCaptureRetryID(t)); err != nil {
		t.Fatalf("request stop: %v", err)
	}
	job, err := repository.Claim(t.Context(), recordingpipeline.ClaimInput{ClaimRequestID: newCaptureRetryID(t), Kind: recordingpipeline.JobKindCapture, Owner: "worker-a", LeaseToken: "lease-a", LeaseFor: time.Minute})
	if !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("claim after stop started job %s: err=%v", job.ID, err)
	}
}
