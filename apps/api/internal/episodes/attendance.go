package episodes

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type AttendanceParticipant struct {
	ParticipantID utilities.ID
	DisplayName   string
	IdentityKind  string
	ExternalID    *string
	FirstJoinedAt time.Time
	LastLeftAt    *time.Time
	LeftReason    *string
}

func (s Service) GetEpisodeAttendance(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) ([]AttendanceParticipant, error) {
	if err := validateTenantSpaceEpisodeIDs(tenantID, spaceID, episodeID); err != nil {
		return nil, err
	}
	return s.repository.GetEpisodeAttendance(ctx, tenantID, spaceID, episodeID)
}
