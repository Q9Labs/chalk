package recordingpipeline

import (
	"context"
	"testing"
	"time"
)

func TestMaintenanceRetiresJobsBeforeExpiringUnclaimedReservations(t *testing.T) {
	now := time.Date(2026, time.September, 8, 12, 0, 0, 0, time.UTC)
	repository := &maintenanceRepositoryStub{}
	service := Service{repository: repository, now: func() time.Time { return now }}

	service.runMaintenanceCycle(t.Context())

	if !repository.recovered {
		t.Fatal("maintenance did not recover expired jobs")
	}
	if !repository.expired || !repository.expiredAt.Equal(now) {
		t.Fatalf("maintenance expiration = called %t at %s, want %s", repository.expired, repository.expiredAt, now)
	}
}

type maintenanceRepositoryStub struct {
	Repository
	recovered bool
	expired   bool
	expiredAt time.Time
}

func (r *maintenanceRepositoryStub) RecoverExpired(context.Context) ([]Job, error) {
	r.recovered = true
	return nil, nil
}

func (r *maintenanceRepositoryStub) ExpireReservations(_ context.Context, now time.Time) ([]Reservation, error) {
	if !r.recovered {
		panic("expiration ran before job recovery")
	}
	r.expired = true
	r.expiredAt = now
	return nil, nil
}
