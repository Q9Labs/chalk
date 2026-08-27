package recordinglifecycle_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
)

const (
	tenantID    = "6a9b6a12-7457-4fe9-a58b-8b234d0be001"
	spaceID     = "6a9b6a12-7457-4fe9-a58b-8b234d0be002"
	episodeID   = "6a9b6a12-7457-4fe9-a58b-8b234d0be003"
	recordingID = "6a9b6a12-7457-4fe9-a58b-8b234d0be004"
	jobID       = "6a9b6a12-7457-4fe9-a58b-8b234d0be005"
)

type recordingLifecycleRepositoryStub struct {
	ready   recordinglifecycle.ReadyInput
	stopped recordinglifecycle.StoppedInput
}

func (s *recordingLifecycleRepositoryStub) PublishReady(_ context.Context, input recordinglifecycle.ReadyInput) (recordinglifecycle.Publication, error) {
	s.ready = input
	return recordinglifecycle.Publication{ExternalOperationID: "6a9b6a12-7457-4fe9-a58b-8b234d0be006"}, nil
}

func (s *recordingLifecycleRepositoryStub) PublishStopped(_ context.Context, input recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error) {
	s.stopped = input
	return recordinglifecycle.Publication{ExternalOperationID: "6a9b6a12-7457-4fe9-a58b-8b234d0be007"}, nil
}

func TestServicePublishesCompleteWorkerAuthority(t *testing.T) {
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	digest := sha256.Sum256([]byte("envelope"))
	repository := new(recordingLifecycleRepositoryStub)
	service, err := recordinglifecycle.NewService(repository, func() time.Time { return now })
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	authority := recordinglifecycle.Authority{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		AttemptCount: 2, FencingGeneration: 4, CaptureEpoch: 7, EnvelopeDigest: digest[:], LeaseOwner: "worker-1",
		LeaseToken: "lease-token", LeaseExpiresAt: now.Add(time.Minute),
	}
	readyAt := now.Add(2 * time.Second)
	if _, err := service.PublishReady(context.Background(), recordinglifecycle.ReadyInput{Authority: authority, RequestKey: "capture_ready_00000001", ReadyAt: readyAt, NoPublisher: true}); err != nil {
		t.Fatalf("publish ready: %v", err)
	}
	if repository.ready.AttemptCount != authority.AttemptCount || repository.ready.FencingGeneration != authority.FencingGeneration || repository.ready.CaptureEpoch != authority.CaptureEpoch || !repository.ready.NoPublisher {
		t.Fatalf("repository received incomplete authority: %#v", repository.ready)
	}
}

func TestServiceRejectsExpiredLeaseAndInvalidRequestKey(t *testing.T) {
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	digest := sha256.Sum256([]byte("envelope"))
	repository := new(recordingLifecycleRepositoryStub)
	service, err := recordinglifecycle.NewService(repository, func() time.Time { return now })
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	authority := recordinglifecycle.Authority{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, EnvelopeDigest: digest[:], LeaseOwner: "worker-1",
		LeaseToken: "lease-token", LeaseExpiresAt: now.Add(-time.Second),
	}
	_, err = service.PublishStopped(context.Background(), recordinglifecycle.StoppedInput{Authority: authority, RequestKey: "capture_stopped_00001", StoppedAt: now})
	if !errors.Is(err, recordinglifecycle.ErrInvalidRequest) {
		t.Fatalf("expired lease error = %v, want invalid request", err)
	}
	authority.LeaseExpiresAt = now.Add(time.Minute)
	_, err = service.PublishReady(context.Background(), recordinglifecycle.ReadyInput{Authority: authority, RequestKey: "contains/slash", ReadyAt: now})
	if !errors.Is(err, recordinglifecycle.ErrInvalidRequest) {
		t.Fatalf("invalid request key error = %v, want invalid request", err)
	}
}
