package recordingpipeline

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (s Service) Claim(ctx context.Context, input ClaimInput) (Job, error) {
	if input.Kind != JobKindCapture && input.Kind != JobKindRender {
		return Job{}, ErrInvalidJobID
	}
	if input.ClaimRequestID.IsZero() {
		return Job{}, ErrInvalidLease
	}
	if input.LeaseFor <= 0 || input.LeaseToken == "" || input.Owner == "" {
		return Job{}, ErrInvalidLease
	}
	return s.repository.Claim(ctx, input)
}

func (s Service) Heartbeat(ctx context.Context, input LeaseInput) (Job, error) {
	if err := ValidateLeaseInput(input); err != nil {
		return Job{}, err
	}
	return s.repository.Heartbeat(ctx, input)
}

func (s Service) Complete(ctx context.Context, input LeaseInput) (Job, error) {
	if err := ValidateLeaseInput(input); err != nil {
		return Job{}, err
	}
	return s.repository.Complete(ctx, input)
}

func (s Service) CompleteCapture(ctx context.Context, input LeaseInput) (Job, error) {
	if err := ValidateLeaseInput(input); err != nil {
		return Job{}, err
	}
	renderJobID, err := utilities.NewID()
	if err != nil {
		return Job{}, err
	}
	return s.repository.CompleteCapture(ctx, input, renderJobID)
}

func (s Service) RelinquishCapture(ctx context.Context, input LeaseInput) (Job, error) {
	if err := ValidateLeaseInput(input); err != nil {
		return Job{}, err
	}
	return s.repository.RelinquishCapture(ctx, input)
}

func (s Service) Fail(ctx context.Context, input FailureInput) (Job, error) {
	if err := ValidateLeaseInput(input.LeaseInput); err != nil {
		return Job{}, err
	}
	if input.AvailableAt.IsZero() {
		input.AvailableAt = s.now().UTC()
	}
	return s.repository.Fail(ctx, input)
}

func (s Service) InsertBundle(ctx context.Context, input BundleInput) (Bundle, error) {
	if err := ValidateBundleInput(input); err != nil {
		return Bundle{}, err
	}
	return s.repository.InsertBundle(ctx, input)
}

func (s Service) CommitArtifact(ctx context.Context, input ArtifactInput) (Artifact, error) {
	if err := ValidateArtifactInput(input); err != nil {
		return Artifact{}, err
	}
	return s.repository.CommitArtifact(ctx, input)
}
