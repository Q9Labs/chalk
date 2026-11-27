package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func nullableErrorFamily(value string) pgtype.Text { return textValue(value) }

func (r PublicInviteRepository) ListLobbyParticipants(ctx context.Context, tenantID, spaceID utilities.ID) ([]publicinvites.LobbyParticipant, error) {
	rows, err := r.queries.ListSpaceLobbyParticipants(ctx, sqlc.ListSpaceLobbyParticipantsParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if err != nil {
		return nil, fmt.Errorf("list lobby participants: %w", err)
	}
	result := make([]publicinvites.LobbyParticipant, 0, len(rows))
	for _, row := range rows {
		result = append(result, publicinvites.LobbyParticipant{
			ParticipantID: utilities.IDFromBytes(row.ID.Bytes),
			DisplayName:   row.DisplayName,
			IdentityKind:  row.IdentityKind,
			Notice:        row.Notice.String,
		})
	}
	return result, nil
}
