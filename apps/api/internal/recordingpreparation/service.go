package recordingpreparation

import (
	"context"
	"log/slog"
	"math"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type SpaceReader interface {
	GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error)
}

type Service struct {
	repository Repository
	spaces     SpaceReader
	now        func() time.Time
}

func NewService(repository Repository, spaces SpaceReader) Service {
	return Service{repository: repository, spaces: spaces, now: time.Now}
}

func (s Service) Prepare(ctx context.Context, input Input) (Preparation, error) {
	now := s.now().UTC()
	if !validInput(input) || input.StartsAt.IsZero() || input.StartsAt.After(now.AddDate(1, 0, 0)) {
		return Preparation{}, ErrInvalidInput
	}
	space, err := s.spaces.GetSpace(ctx, input.TenantID, input.SpaceID)
	if err != nil {
		return Preparation{}, err
	}
	if space.ArchivedAt != nil || space.RecordingPolicy == artifactpolicy.RecordingDisabled {
		return Preparation{}, ErrPolicyDenied
	}
	input.StartsAt = input.StartsAt.UTC().Truncate(time.Microsecond)
	preparation, err := s.repository.Prepare(ctx, input, now)
	logMutation(ctx, "prepare", err)
	return preparation.At(now), err
}

func (s Service) Cancel(ctx context.Context, input Input) (Preparation, error) {
	if !validInput(input) {
		return Preparation{}, ErrInvalidInput
	}
	now := s.now().UTC()
	preparation, err := s.repository.Cancel(ctx, input, now)
	logMutation(ctx, "cancel", err)
	return preparation.At(now), err
}

func (s Service) Get(ctx context.Context, tenantID, spaceID utilities.ID) (Preparation, error) {
	if tenantID.IsZero() || spaceID.IsZero() {
		return Preparation{}, ErrInvalidInput
	}
	now := s.now().UTC()
	preparation, err := s.repository.Get(ctx, tenantID, spaceID, now)
	return preparation.At(now), err
}

func validInput(input Input) bool {
	return !input.TenantID.IsZero() && !input.SpaceID.IsZero() && input.ExpectedRevision >= 0 && input.ExpectedRevision < math.MaxInt64
}

func logMutation(ctx context.Context, operation string, err error) {
	if err != nil {
		slog.WarnContext(ctx, "recording preparation rejected", "event", "recording.preparation.rejected", "operation", operation, "error", err)
		return
	}
	slog.InfoContext(ctx, "recording preparation updated", "event", "recording.preparation.updated", "operation", operation)
}
