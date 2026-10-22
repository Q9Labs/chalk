package episodes

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const MaximumActivitySpaces = 300

var ErrInvalidActivitySpaceIDs = errors.New("space activity reads require 1 to 300 distinct Space IDs")

type LatestEpisode struct {
	EpisodeID utilities.ID
	Status    string
	StartedAt time.Time
	EndedAt   *time.Time
}

// SpaceActivity holds at most five live Participants; LiveParticipantCount counts the whole live roster.
type SpaceActivity struct {
	SpaceID              utilities.ID
	LiveEpisode          *LiveEpisode
	LiveParticipantCount int
	LatestEpisode        *LatestEpisode
	RecentParticipants   []PresentParticipant
}

func (s Service) ListSpaceActivity(ctx context.Context, tenantID utilities.ID, spaceIDs []utilities.ID) ([]SpaceActivity, error) {
	if tenantID.IsZero() {
		return nil, ErrInvalidTenantID
	}
	if len(spaceIDs) == 0 || len(spaceIDs) > MaximumActivitySpaces {
		return nil, ErrInvalidActivitySpaceIDs
	}
	seen := make(map[utilities.ID]bool, len(spaceIDs))
	for _, id := range spaceIDs {
		if id.IsZero() || seen[id] {
			return nil, ErrInvalidActivitySpaceIDs
		}
		seen[id] = true
	}
	return s.repository.ListSpaceActivity(ctx, tenantID, spaceIDs)
}
