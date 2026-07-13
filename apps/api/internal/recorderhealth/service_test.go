package recorderhealth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type repositoryStub struct {
	health recordingpipeline.PoolHealth
	err    error
}

func (r repositoryStub) GetPoolHealth(context.Context, recordingpipeline.PoolRole) (recordingpipeline.PoolHealth, error) {
	return r.health, r.err
}

func TestServiceFailsClosedOnStaleOrUnavailablePool(t *testing.T) {
	now := time.Date(2026, 7, 13, 2, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		repository Repository
		wantErr    bool
	}{
		{name: "ready", repository: repositoryStub{health: recordingpipeline.PoolHealth{Role: recordingpipeline.PoolRoleCapture, AdmissionOpen: true, ReadyCapacity: 1, ObservedAt: now}}, wantErr: false},
		{name: "stale", repository: repositoryStub{health: recordingpipeline.PoolHealth{Role: recordingpipeline.PoolRoleCapture, AdmissionOpen: true, ReadyCapacity: 1, ObservedAt: now.Add(-3 * time.Minute)}}, wantErr: true},
		{name: "closed", repository: repositoryStub{health: recordingpipeline.PoolHealth{Role: recordingpipeline.PoolRoleCapture, AdmissionOpen: false, ReadyCapacity: 1, ObservedAt: now}}, wantErr: true},
		{name: "missing", repository: repositoryStub{err: errors.New("missing")}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := NewService(test.repository, 2*time.Minute)
			service.now = func() time.Time { return now }
			err := service.CheckRecorderPool(context.Background(), workeridentity.RoleCapture)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, want error %t", err, test.wantErr)
			}
		})
	}
}
