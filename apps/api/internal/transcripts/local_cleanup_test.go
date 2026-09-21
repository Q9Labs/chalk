package transcripts

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type localCleanupServiceStub struct {
	job       CleanupJob
	claimed   bool
	completed []CleanupLeaseInput
	recovered bool
}

func (s *localCleanupServiceStub) ClaimCleanup(context.Context, CleanupClaimInput) (CleanupJob, string, error) {
	if s.claimed {
		return CleanupJob{}, "", ErrNoClaimableJob
	}
	s.claimed = true
	return s.job, "lease-token", nil
}

func (s *localCleanupServiceStub) CleanupKey(_ context.Context, input CleanupLeaseInput) (string, error) {
	if input.JobID != s.job.ID || input.LeaseToken != "lease-token" {
		return "", ErrStaleLease
	}
	return s.job.ObjectKey, nil
}

func (s *localCleanupServiceStub) CompleteCleanup(_ context.Context, input CleanupLeaseInput) (CleanupJob, error) {
	s.completed = append(s.completed, input)
	return s.job, nil
}

func (*localCleanupServiceStub) RetryCleanup(context.Context, CleanupRetryInput) (CleanupJob, error) {
	return CleanupJob{}, nil
}

func (s *localCleanupServiceStub) RecoverExpiredCleanup(context.Context, time.Time, time.Time) ([]CleanupJob, error) {
	s.recovered = true
	return nil, nil
}

type localCleanupObjectsStub struct {
	keys []string
}

func (s *localCleanupObjectsStub) DeleteObject(_ context.Context, key string) error {
	s.keys = append(s.keys, key)
	return nil
}

func TestLocalCleanupWorkerUsesDurableClaimBeforeDeletingSource(t *testing.T) {
	jobID, err := utilities.ParseID("6a9b6a12-7457-4fe9-a58b-8b234d0be001")
	if err != nil {
		t.Fatal(err)
	}
	service := &localCleanupServiceStub{job: CleanupJob{ID: jobID, Attempt: 2, ObjectKey: "tenants/tenant/recordings/recording/capture/1/bundles/0.bundle"}}
	objects := &localCleanupObjectsStub{}
	worker := NewLocalCleanupWorker(service, objects)
	worker.now = func() time.Time { return time.Date(2031, 2, 3, 4, 5, 6, 0, time.UTC) }

	result, err := worker.Run(context.Background())
	if err != nil {
		t.Fatalf("run cleanup worker: %v", err)
	}
	if !service.recovered || result.Claimed != 1 || result.Completed != 1 || result.Failed != 0 || len(objects.keys) != 1 || objects.keys[0] != service.job.ObjectKey || len(service.completed) != 1 || service.completed[0].Attempt != service.job.Attempt {
		t.Fatalf("cleanup result=%+v recovered=%t keys=%v completed=%+v", result, service.recovered, objects.keys, service.completed)
	}
}
