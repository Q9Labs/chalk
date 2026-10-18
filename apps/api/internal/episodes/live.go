package episodes

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const MaximumLiveEpisodeSpaces = 30

var ErrInvalidSpaceIDs = errors.New("live Episode reads require 1 to 30 distinct Space IDs")

type PresentParticipant struct {
	ParticipantID utilities.ID
	DisplayName   string
}

type LiveEpisode struct {
	EpisodeID    utilities.ID
	Participants []PresentParticipant
}

type SpaceLiveEpisode struct {
	SpaceID utilities.ID
	Episode *LiveEpisode
}

func (s Service) ListSpaceLiveEpisodes(ctx context.Context, tenantID utilities.ID, spaceIDs []utilities.ID) ([]SpaceLiveEpisode, error) {
	if tenantID.IsZero() {
		return nil, ErrInvalidTenantID
	}
	if len(spaceIDs) == 0 || len(spaceIDs) > MaximumLiveEpisodeSpaces {
		return nil, ErrInvalidSpaceIDs
	}
	seen := make(map[utilities.ID]bool, len(spaceIDs))
	for _, id := range spaceIDs {
		if id.IsZero() || seen[id] {
			return nil, ErrInvalidSpaceIDs
		}
		seen[id] = true
	}
	return s.repository.ListSpaceLiveEpisodes(ctx, tenantID, spaceIDs)
}
