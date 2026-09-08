package recordingpipeline

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestClaimRecoversAbandonedWorkBeforeAdmission(t *testing.T) {
	requestID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("maintenance unavailable")
	for _, stage := range []string{"", "recover", "expire"} {
		t.Run(stage, func(t *testing.T) {
			repository := &claimMaintenanceRepository{failStage: stage, failure: failure}
			service := NewService(repository)
			_, err := service.Claim(context.Background(), ClaimInput{Kind: JobKindCapture, ClaimRequestID: requestID, Owner: "worker", LeaseToken: "lease", LeaseFor: time.Minute})
			want := []string{"recover", "expire", "claim"}
			if stage == "recover" {
				want = want[:1]
			} else if stage == "expire" {
				want = want[:2]
			}
			if !reflect.DeepEqual(repository.calls, want) {
				t.Fatalf("claim calls = %v, want %v", repository.calls, want)
			}
			if stage == "" && err != nil || stage != "" && !errors.Is(err, failure) {
				t.Fatalf("claim error = %v for maintenance failure %q", err, stage)
			}
		})
	}
}

type claimMaintenanceRepository struct {
	Repository
	calls     []string
	failStage string
	failure   error
}

func (r *claimMaintenanceRepository) RecoverExpired(context.Context) ([]Job, error) {
	r.calls = append(r.calls, "recover")
	if r.failStage == "recover" {
		return nil, r.failure
	}
	return nil, nil
}

func (r *claimMaintenanceRepository) ExpireReservations(context.Context, time.Time) ([]Reservation, error) {
	r.calls = append(r.calls, "expire")
	if r.failStage == "expire" {
		return nil, r.failure
	}
	return nil, nil
}

func (r *claimMaintenanceRepository) Claim(context.Context, ClaimInput) (Job, error) {
	r.calls = append(r.calls, "claim")
	return Job{}, nil
}
