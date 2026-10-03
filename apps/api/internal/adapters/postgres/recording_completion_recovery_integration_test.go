package postgres_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recoveryObjects struct {
	err     error
	corrupt bool
}

func (s recoveryObjects) InspectObject(context.Context, string) (objectstorage.ObjectFacts, error) {
	digest := bytes.Repeat([]byte{0xab}, 32)
	if s.corrupt {
		digest[0] ^= 0xff
	}
	return objectstorage.ObjectFacts{Object: objectstorage.Object{Size: 32, ChecksumSHA256: base64.StdEncoding.EncodeToString(digest)}}, s.err
}

func testCompletionRecovery(t *testing.T, ctx context.Context, pool *pgxpool.Pool, original recordingpipeline.Job, claim func(string) (recordingpipeline.Job, recordingpipeline.LeaseInput), complete bool) {
	t.Helper()
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	newID := func() utilities.ID {
		t.Helper()
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	input := recordingpipeline.CompletionRecoveryInput{TenantID: original.TenantID, RecordingID: original.RecordingID,
		RequestID: newID(), Operator: "test-operator", Reason: "Completion fault repaired"}
	// Model the retained encrypted source of an exhausted Capture.
	if _, err := pool.Exec(ctx, `insert into recording_bundles(id, tenant_id, recording_id, capture_job_id, sequence_number, fencing_generation, object_key, content_type, codec, byte_size, checksum, monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis)
 values($1,$2,$3,$4,0,$5,'recovery/bundle','application/octet-stream','opus',32,decode(repeat('ab',32),'hex'),0,1000,0,1000)`, input.RequestID.Bytes(), input.TenantID.Bytes(), input.RecordingID.Bytes(), original.ID.Bytes(), original.FencingGeneration); err != nil {
		t.Fatal(err)
	}
	t.Run("missing Capture key", func(t *testing.T) {
		if err := repository.RequestCompletionRecovery(ctx, input, recoveryObjects{}); !errors.Is(err, recordingpipeline.ErrCompletionRecoveryUnavailable) {
			t.Fatalf("missing Capture key: %v", err)
		}
	})
	if _, err := pool.Exec(ctx, `insert into recording_data_keys(recording_id,capture_epoch,tenant_id,episode_id,job_id,attempt_count,fencing_generation,key_handle,environment,envelope_digest,encryption_context_digest,ciphertext_blob)
 values($1,$2,$3,$4,$5,$6,$7,$8,'test',$9,decode(repeat('ab',32),'hex'),'retained-key')`, original.RecordingID.Bytes(), original.CaptureEpoch, original.TenantID.Bytes(), original.EpisodeID.Bytes(), original.ID.Bytes(), original.AttemptCount, original.FencingGeneration, input.RequestID.Bytes(), original.Authority.EnvelopeDigest); err != nil {
		t.Fatal(err)
	}
	t.Run("expired source", func(t *testing.T) {
		var stopped time.Time
		if err := pool.QueryRow(ctx, `update recording_pipelines set stop_requested_at=now()-interval '31 days' where recording_id=$1 returning updated_at`, input.RecordingID.Bytes()).Scan(&stopped); err != nil {
			t.Fatal(err)
		}
		if err := repository.RequestCompletionRecovery(ctx, input, recoveryObjects{}); !errors.Is(err, recordingpipeline.ErrCompletionRecoveryUnavailable) {
			t.Fatalf("expired source: %v", err)
		}
		if _, err := pool.Exec(ctx, `update recording_pipelines set stop_requested_at=$2 where recording_id=$1`, input.RecordingID.Bytes(), stopped); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("erased source", func(t *testing.T) {
		if err := repository.RequestCompletionRecovery(ctx, input, recoveryObjects{err: objectstorage.ErrObjectNotFound}); !errors.Is(err, recordingpipeline.ErrCompletionRecoveryUnavailable) {
			t.Fatalf("erased source: %v", err)
		}
	})
	t.Run("source store unavailable", func(t *testing.T) {
		if err := repository.RequestCompletionRecovery(ctx, input, recoveryObjects{err: objectstorage.ErrStoreUnavailable}); !errors.Is(err, recordingpipeline.ErrCompletionRecoveryUnavailable) {
			t.Fatalf("source inspection failure: %v", err)
		}
	})
	t.Run("wrong Tenant", func(t *testing.T) {
		denied := input
		denied.TenantID = newID()
		if err := repository.RequestCompletionRecovery(ctx, denied, recoveryObjects{}); !errors.Is(err, recordingpipeline.ErrCompletionRecoveryUnavailable) {
			t.Fatalf("wrong Tenant: %v", err)
		}
	})
	t.Run("corrupted source", func(t *testing.T) {
		if err := repository.RequestCompletionRecovery(ctx, input, recoveryObjects{corrupt: true}); !errors.Is(err, recordingpipeline.ErrCompletionRecoveryUnavailable) {
			t.Fatalf("corrupted source: %v", err)
		}
	})
	t.Run("recover and retain audit", func(t *testing.T) {
		requests := make(chan error, 2)
		for range 2 {
			go func() { requests <- repository.RequestCompletionRecovery(ctx, input, recoveryObjects{}) }()
		}
		for range 2 {
			if err := <-requests; err != nil {
				t.Fatalf("concurrent recovery request: %v", err)
			}
		}
		if err := repository.RequestCompletionRecovery(ctx, input, recoveryObjects{}); err != nil {
			t.Fatalf("replay request: %v", err)
		}
		different := input
		different.RequestID = newID()
		if err := repository.RequestCompletionRecovery(ctx, different, recoveryObjects{}); !errors.Is(err, recordingpipeline.ErrCompletionRecoveryAlreadyRequested) {
			t.Fatalf("double request: %v", err)
		}
		reconciled, err := repository.RecoverExpired(ctx)
		if err != nil {
			t.Fatalf("reconcile queued recovery: %v", err)
		}
		for _, job := range reconciled {
			if job.ID == original.ID {
				t.Fatalf("reconciler consumed queued recovery: %+v", job)
			}
		}
		recovered, lease := claim(newID().String())
		if recovered.CaptureEpoch != original.CaptureEpoch || recovered.AttemptCount != original.AttemptCount+4 {
			t.Fatalf("recovery reset history: %+v", recovered)
		}
		heartbeat := lease
		heartbeat.LeaseFor = 60 * 24 * time.Hour
		renewed, err := repository.Heartbeat(ctx, heartbeat)
		if err != nil {
			t.Fatalf("heartbeat recovery: %v", err)
		}
		var deadline time.Time
		if err := pool.QueryRow(ctx, `select source_expires_at from recording_completion_recoveries where job_id=$1`, original.ID.Bytes()).Scan(&deadline); err != nil {
			t.Fatal(err)
		}
		if renewed.LeaseExpiresAt == nil || renewed.LeaseExpiresAt.After(deadline) {
			t.Fatal("recovery heartbeat extended source retention")
		}
		if complete {
			if _, err := repository.CompleteCapture(ctx, lease, newID()); err != nil {
				t.Fatalf("complete recovery: %v", err)
			}
		} else {
			failed, err := repository.Fail(ctx, recordingpipeline.FailureInput{LeaseInput: lease, AvailableAt: time.Now().Add(-time.Second), ErrorCode: "capture_completion_failed", ErrorDetail: "recovery failed"})
			if err != nil || failed.State != recordingpipeline.JobStateTerminalFailure {
				t.Fatalf("recovery received automatic retries: %+v %v", failed, err)
			}
			if _, err := repository.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: newID(), Kind: recordingpipeline.JobKindCapture, Owner: "recovery-test", LeaseToken: "recovery-test-token", LeaseFor: time.Minute, SupportsCompletionOnly: true}); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
				t.Fatalf("claimed after recovery exhausted: %v", err)
			}
			if err := repository.RequestCompletionRecovery(ctx, different, recoveryObjects{}); !errors.Is(err, recordingpipeline.ErrCompletionRecoveryAlreadyRequested) {
				t.Fatalf("second recovery after failure: %v", err)
			}
		}
		var operator, reason, detail string
		var attempts, authorities int
		if err := pool.QueryRow(ctx, `select operator,reason,error_detail,attempt_count from recording_completion_recoveries where job_id=$1`, original.ID.Bytes()).Scan(&operator, &reason, &detail, &attempts); err != nil {
			t.Fatal(err)
		}
		if operator != input.Operator || reason != input.Reason || detail != "stage=api_complete outcome=returned error_class=http http_status=503" || attempts != original.AttemptCount+3 {
			t.Fatalf("lost failure audit: %s %s %s %d", operator, reason, detail, attempts)
		}
		if err := pool.QueryRow(ctx, `select count(*) from recording_job_attempt_authorities where job_id=$1 and (convert_from(envelope_bytes,'UTF8')::jsonb->>'completion_only')::boolean`, original.ID.Bytes()).Scan(&authorities); err != nil || authorities != 4 {
			t.Fatalf("authority history: %d %v", authorities, err)
		}
		if _, err := pool.Exec(ctx, `update recording_completion_recoveries set reason='changed' where job_id=$1`, original.ID.Bytes()); err == nil {
			t.Fatal("audit was mutable")
		}
	})
}
