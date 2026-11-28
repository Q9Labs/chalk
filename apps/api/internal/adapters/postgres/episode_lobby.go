package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) ListLobbyParticipants(ctx context.Context, tenantID, spaceID utilities.ID) ([]episodes.LobbyParticipant, error) {
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin lobby participant read: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := sqlc.New(tx).ListSpaceLobbyParticipants(ctx, sqlc.ListSpaceLobbyParticipantsParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if err != nil {
		return nil, fmt.Errorf("list lobby participants: %w", err)
	}
	result := make([]episodes.LobbyParticipant, 0, len(rows))
	for _, row := range rows {
		result = append(result, episodes.LobbyParticipant{
			ParticipantID: utilities.IDFromBytes(row.ID.Bytes),
			DisplayName:   row.DisplayName,
			IdentityKind:  row.IdentityKind,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit lobby participant read: %w", err)
	}
	return result, nil
}
