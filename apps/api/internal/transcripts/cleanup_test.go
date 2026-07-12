package transcripts

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type cleanupRepositoryStub struct{ enqueued []CleanupEnqueueInput }

func (s *cleanupRepositoryStub) EnqueueCleanup(_ context.Context, input CleanupEnqueueInput) (CleanupJob, error) {
	s.enqueued = append(s.enqueued, input)
	return CleanupJob{ObjectKey: input.ObjectKey, DueAt: input.DueAt}, nil
}
func (*cleanupRepositoryStub) ClaimCleanup(context.Context, CleanupClaimInput) (CleanupJob, string, error) {
	return CleanupJob{}, "", nil
}
func (*cleanupRepositoryStub) CleanupKey(context.Context, CleanupLeaseInput) (string, error) {
	return "", nil
}
func (*cleanupRepositoryStub) CompleteCleanup(context.Context, CleanupLeaseInput) (CleanupJob, error) {
	return CleanupJob{}, nil
}
func (*cleanupRepositoryStub) RetryCleanup(context.Context, CleanupRetryInput) (CleanupJob, error) {
	return CleanupJob{}, nil
}
func (*cleanupRepositoryStub) RecoverExpiredCleanup(context.Context, time.Time, time.Time) ([]CleanupJob, error) {
	return nil, nil
}

func TestCleanupEnqueueBoundsDeadlineAndPreservesExactKey(t *testing.T) {
	repository := &cleanupRepositoryStub{}
	service := Service{cleanup: repository}
	tenant, _ := utilities.NewID()
	transcript, _ := utilities.NewID()
	now := time.Now()
	job, err := service.EnqueueCleanup(context.Background(), CleanupEnqueueInput{TenantID: tenant, TranscriptID: transcript, ObjectKey: "tenants/t/transcripts/x/chunks/1.json", ObjectKind: "temp_result", DueAt: now.Add(time.Hour)})
	if err != nil {
		t.Fatalf("enqueue failed: %v", err)
	}
	if job.ObjectKey != repository.enqueued[0].ObjectKey || job.DueAt.After(now.Add(time.Hour+time.Second)) {
		t.Fatalf("cleanup key/deadline changed: %#v", job)
	}
	if _, err := service.EnqueueCleanup(context.Background(), CleanupEnqueueInput{TenantID: tenant, TranscriptID: transcript, ObjectKey: "key", ObjectKind: "final_artifact", DueAt: now.Add(25 * time.Hour)}); err == nil {
		t.Fatal("cleanup deadline beyond 24 hours accepted")
	}
}
