package episodes

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// LobbyParticipant is the privacy-limited roster a person may see before joining.
type LobbyParticipant struct {
	ParticipantID utilities.ID
	DisplayName   string
	IdentityKind  string
	Notice        string
}

func (s Service) ListLobbyParticipants(ctx context.Context, tenantID, spaceID utilities.ID) ([]LobbyParticipant, error) {
	if tenantID.IsZero() {
		return nil, ErrInvalidTenantID
	}
	if spaceID.IsZero() {
		return nil, ErrInvalidSpaceID
	}
	return s.repository.ListLobbyParticipants(ctx, tenantID, spaceID)
}
