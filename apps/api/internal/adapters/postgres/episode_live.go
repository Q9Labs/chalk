package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) ListSpaceLiveEpisodes(ctx context.Context, tenantID utilities.ID, spaceIDs []utilities.ID) ([]episodes.SpaceLiveEpisode, error) {
	ids := make([]pgtype.UUID, 0, len(spaceIDs))
	for _, id := range spaceIDs {
		ids = append(ids, uuid(id))
	}
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin live Episode read: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := sqlc.New(tx).ListSpaceLiveEpisodes(ctx, sqlc.ListSpaceLiveEpisodesParams{TenantID: uuid(tenantID), SpaceIds: ids})
	if err != nil {
		return nil, fmt.Errorf("list live Episodes: %w", err)
	}
	if len(rows) != len(spaceIDs) {
		return nil, episodes.ErrSpaceNotFound
	}
	result := make([]episodes.SpaceLiveEpisode, 0, len(rows))
	for _, row := range rows {
		item := episodes.SpaceLiveEpisode{SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes)}
		if row.EpisodeID.Valid {
			live := episodes.LiveEpisode{EpisodeID: utilities.IDFromBytes(row.EpisodeID.Bytes), Participants: []episodes.PresentParticipant{}}
			var participants []struct {
				ParticipantID string `json:"participant_id"`
				DisplayName   string `json:"display_name"`
			}
			if err := json.Unmarshal(row.Participants, &participants); err != nil {
				return nil, fmt.Errorf("decode live Episode participants: %w", err)
			}
			for _, participant := range participants {
				id, err := utilities.ParseID(participant.ParticipantID)
				if err != nil {
					return nil, fmt.Errorf("decode live Participant ID: %w", err)
				}
				live.Participants = append(live.Participants, episodes.PresentParticipant{ParticipantID: id, DisplayName: participant.DisplayName})
			}
			item.Episode = &live
		}
		result = append(result, item)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit live Episode read: %w", err)
	}
	return result, nil
}
