package transcripts

import (
	"context"
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type FinalizerChunk struct {
	ID                utilities.ID
	Generation        int64
	StartMS           int64
	EndMS             int64
	ResultKey         string
	ResultSHA256      []byte
	ResultSize        int64
	ResultContentType string
}

type FinalizerAssignment struct {
	Job        Job
	LeaseToken string
	Transcript Transcript
	Chunks     []FinalizerChunk
}

type FinalizerClaimInput struct {
	Owner         string
	LeaseDuration time.Duration
	Now           time.Time
}

type FinalizerCompleteInput struct {
	JobID               utilities.ID
	Attempt             int
	LeaseOwner          string
	LeaseToken          string
	Provider            string
	Model               string
	VersionContract     string
	ExecutionIdentity   string
	ProviderRequestID   string
	Languages           []string
	ArtifactSHA256      []byte
	ArtifactSize        int64
	ArtifactContentType string
	Quality             json.RawMessage
	Now                 time.Time
}

type FinalizerRetryInput struct {
	CleanupLeaseInput
	DueAt       time.Time
	ErrorCode   string
	ErrorDetail string
	Terminal    bool
}

type FinalizerRepository interface {
	ClaimFinalizer(context.Context, FinalizerClaimInput) (FinalizerAssignment, error)
	FinalizerKey(context.Context, LeaseInput) (string, error)
	CompleteFinalizer(context.Context, FinalizerCompleteInput) (Transcript, error)
	RetryFinalizer(context.Context, RetryInput) (Job, error)
}

func (s Service) ClaimFinalizer(ctx context.Context, input FinalizerClaimInput) (FinalizerAssignment, error) {
	if s.finalizer == nil {
		return FinalizerAssignment{}, ErrArtifactRepository
	}
	if input.Owner == "" || input.LeaseDuration <= 0 || input.LeaseDuration > 15*time.Minute {
		return FinalizerAssignment{}, ErrInvalidLease
	}
	if input.Now.IsZero() {
		input.Now = time.Now()
	}
	return s.finalizer.ClaimFinalizer(ctx, input)
}

func (s Service) CompleteFinalizer(ctx context.Context, input FinalizerCompleteInput) (Transcript, error) {
	if s.finalizer == nil {
		return Transcript{}, ErrArtifactRepository
	}
	if input.JobID.IsZero() || input.Attempt < 1 || input.LeaseToken == "" || len(input.ArtifactSHA256) != 32 || input.ArtifactSize < 1 || input.ArtifactSize > 524288000 || input.ArtifactContentType != "application/json" {
		return Transcript{}, ErrInvalidArtifact
	}
	if input.Provider == "" || len(input.Provider) > 128 || input.Model == "" || len(input.Model) > 256 || input.VersionContract == "" || len(input.VersionContract) > 256 || len(input.ExecutionIdentity) > 256 || len(input.ProviderRequestID) > 256 {
		return Transcript{}, ErrInvalidArtifact
	}
	if len(input.Quality) == 0 {
		input.Quality = json.RawMessage(`{}`)
	}
	if !json.Valid(input.Quality) || len(input.Quality) > 16384 {
		return Transcript{}, ErrInvalidArtifact
	}
	return s.finalizer.CompleteFinalizer(ctx, input)
}

func (s Service) FinalizerKey(ctx context.Context, input LeaseInput) (string, error) {
	if s.finalizer == nil {
		return "", ErrArtifactRepository
	}
	resolver, ok := s.finalizer.(interface {
		FinalizerKey(context.Context, LeaseInput) (string, error)
	})
	if !ok {
		return "", ErrArtifactRepository
	}
	return resolver.FinalizerKey(ctx, input)
}

func (s Service) RetryFinalizer(ctx context.Context, input RetryInput) (Job, error) {
	if s.finalizer == nil {
		return Job{}, ErrArtifactRepository
	}
	return s.finalizer.RetryFinalizer(ctx, input)
}
