package recordingpipeline

import (
	"context"
	"testing"
	"time"
)

type claimRepository struct {
	Repository
	claimed ClaimInput
}

func (r *claimRepository) Claim(_ context.Context, input ClaimInput) (Job, error) {
	r.claimed = input
	return Job{Kind: input.Kind}, nil
}

// The embedded Repository is nil, so a Claim that ran recovery or reservation
// expiry would panic: maintenance belongs to RunMaintenance alone.
func TestClaimDoesNotRunMaintenance(t *testing.T) {
	repository := &claimRepository{}
	input := ClaimInput{Kind: JobKindCapture, ClaimRequestID: newTestID(t), LeaseFor: time.Minute, LeaseToken: "token", Owner: "worker"}

	job, err := Service{repository: repository}.Claim(t.Context(), input)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if job.Kind != JobKindCapture || repository.claimed.Owner != "worker" {
		t.Fatalf("claim = %+v from %+v, want the repository claim", job, repository.claimed)
	}
}
