package transcripts

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (s Service) Request(ctx context.Context, input RequestInput) (Transcript, Job, error) {
	if s.artifacts == nil {
		return Transcript{}, Job{}, ErrArtifactRepository
	}
	if len(input.Chunks) == 0 {
		if sourceRepository, ok := s.repository.(SourceRepository); ok {
			source, err := sourceRepository.LoadSource(ctx, input.TenantID, input.RecordingID)
			if err != nil {
				return Transcript{}, Job{}, err
			}
			input.ManifestKey, input.ManifestSHA256, input.ManifestSize, input.ManifestContentType, input.Chunks = source.ManifestKey, source.ManifestSHA256, source.ManifestSize, source.ManifestContentType, source.Chunks
		}
	}
	if err := prepareRequestInput(&input); err != nil {
		return Transcript{}, Job{}, err
	}
	transcript, job, err := s.artifacts.Request(ctx, input)
	if err == nil && s.waker != nil {
		s.waker.Wake(ctx, DispatcherWakeInput{JobID: job.ID, JourneyID: input.JourneyID, Traceparent: input.Traceparent, Tracestate: input.Tracestate})
	}
	return transcript, job, err
}

func (s Service) Claim(ctx context.Context, input ClaimInput) (Assignment, error) {
	if s.artifacts == nil {
		return Assignment{}, ErrArtifactRepository
	}
	if err := prepareClaimInput(&input); err != nil {
		return Assignment{}, err
	}
	return s.artifacts.Claim(ctx, input)
}

func (s Service) Heartbeat(ctx context.Context, input LeaseInput, expiresAt time.Time) (Job, error) {
	if s.artifacts == nil {
		return Job{}, ErrArtifactRepository
	}
	if err := prepareLeaseInput(&input); err != nil {
		return Job{}, err
	}
	return s.artifacts.Heartbeat(ctx, input, expiresAt)
}

func (s Service) Retry(ctx context.Context, input RetryInput) (Job, error) {
	if s.artifacts == nil {
		return Job{}, ErrArtifactRepository
	}
	if err := prepareLeaseInput(&input.LeaseInput); err != nil {
		return Job{}, err
	}
	return s.artifacts.Retry(ctx, input)
}

func (s Service) Complete(ctx context.Context, input LeaseInput) (Job, error) {
	if s.artifacts == nil {
		return Job{}, ErrArtifactRepository
	}
	if err := prepareLeaseInput(&input); err != nil {
		return Job{}, err
	}
	return s.artifacts.Complete(ctx, input)
}

func (s Service) Cancel(ctx context.Context, input CancelInput) (Job, error) {
	if s.artifacts == nil {
		return Job{}, ErrArtifactRepository
	}
	if err := prepareLeaseInput(&input.LeaseInput); err != nil {
		return Job{}, err
	}
	return s.artifacts.Cancel(ctx, input)
}

func (s Service) Requeue(ctx context.Context, jobID utilities.ID, availableAt time.Time) (Job, error) {
	if s.artifacts == nil {
		return Job{}, ErrArtifactRepository
	}
	if jobID.IsZero() {
		return Job{}, ErrJobNotFound
	}
	return s.artifacts.Requeue(ctx, jobID, availableAt)
}

func (s Service) RecoverExpired(ctx context.Context, now, availableAt time.Time) ([]Job, error) {
	if s.artifacts == nil {
		return nil, ErrArtifactRepository
	}
	return s.artifacts.RecoverExpired(ctx, now, availableAt)
}

func (s Service) AcceptResult(ctx context.Context, input ResultInput) (Result, error) {
	if s.artifacts == nil {
		return Result{}, ErrArtifactRepository
	}
	if err := prepareResultInput(&input); err != nil {
		return Result{}, err
	}
	return s.artifacts.AcceptResult(ctx, input)
}

func (s Service) ResultKey(ctx context.Context, input LeaseInput) (string, error) {
	if s.artifacts == nil {
		return "", ErrArtifactRepository
	}
	if err := prepareLeaseInput(&input); err != nil {
		return "", err
	}
	resolver, ok := s.artifacts.(interface {
		ResultKey(context.Context, LeaseInput) (string, error)
	})
	if !ok {
		return "", ErrArtifactRepository
	}
	return resolver.ResultKey(ctx, input)
}

func (s Service) Finalize(ctx context.Context, input FinalizeInput) (Transcript, error) {
	if s.artifacts == nil {
		return Transcript{}, ErrArtifactRepository
	}
	if input.TranscriptID.IsZero() || input.ArtifactKey == "" || len(input.ArtifactSHA256) != 32 || input.ArtifactSize < 1 || input.ArtifactSize > 524288000 || input.ArtifactContentType != "application/json" {
		return Transcript{}, ErrInvalidArtifact
	}
	if input.Provider == "" || len(input.Provider) > 128 || input.Model == "" || len(input.Model) > 256 {
		return Transcript{}, ErrInvalidArtifact
	}
	finalizer, ok := s.artifacts.(interface {
		Finalize(context.Context, FinalizeInput) (Transcript, error)
	})
	if !ok {
		return Transcript{}, ErrArtifactRepository
	}
	return finalizer.Finalize(ctx, input)
}

func (s Service) Delete(ctx context.Context, tenantID, transcriptID utilities.ID) (Transcript, error) {
	if s.artifacts == nil {
		return Transcript{}, ErrArtifactRepository
	}
	if tenantID.IsZero() {
		return Transcript{}, ErrInvalidTenantID
	}
	if transcriptID.IsZero() {
		return Transcript{}, ErrInvalidTranscriptID
	}
	return s.artifacts.Delete(ctx, tenantID, transcriptID)
}
