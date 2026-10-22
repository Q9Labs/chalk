package episodes

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type CancelParticipantJoinInput struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	MediaConnectionID     string
}

type ParticipantJoinRepository interface {
	CancelParticipantJoin(context.Context, CancelParticipantJoinInput) (bool, error)
}

func (s Service) CancelParticipantJoin(ctx context.Context, input CancelParticipantJoinInput) (bool, error) {
	repository, ok := s.repository.(ParticipantJoinRepository)
	if !ok {
		return false, ErrParticipantNotActive
	}
	return repository.CancelParticipantJoin(ctx, input)
}
