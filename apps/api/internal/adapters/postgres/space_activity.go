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

func (r EpisodeLifecycleRepository) ListSpaceActivity(ctx context.Context, tenantID utilities.ID, spaceIDs []utilities.ID) ([]episodes.SpaceActivity, error) {
	ids := make([]pgtype.UUID, 0, len(spaceIDs))
	for _, id := range spaceIDs {
		ids = append(ids, uuid(id))
	}
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin Space activity read: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := sqlc.New(tx).ListSpaceActivity(ctx, sqlc.ListSpaceActivityParams{TenantID: uuid(tenantID), SpaceIds: ids})
	if err != nil {
		return nil, fmt.Errorf("list Space activity: %w", err)
	}
	if len(rows) != len(spaceIDs) {
		return nil, episodes.ErrSpaceNotFound
	}
	result := make([]episodes.SpaceActivity, 0, len(rows))
	for _, row := range rows {
		recent, err := decodeActivityParticipants(row.RecentParticipants)
		if err != nil {
			return nil, err
		}
		item := episodes.SpaceActivity{SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), RecentParticipants: recent}
		if row.LiveEpisodeID.Valid {
			participants, err := decodeActivityParticipants(row.LiveParticipants)
			if err != nil {
				return nil, err
			}
			item.LiveEpisode = &episodes.LiveEpisode{EpisodeID: utilities.IDFromBytes(row.LiveEpisodeID.Bytes), Participants: participants}
			item.LiveParticipantCount = int(row.LiveParticipantCount)
		}
		if row.LatestEpisodeID.Valid {
			item.LatestEpisode = &episodes.LatestEpisode{EpisodeID: utilities.IDFromBytes(row.LatestEpisodeID.Bytes), Status: row.Status, StartedAt: timestamp(row.StartedAt), EndedAt: nullableTimestamp(row.EndedAt)}
		}
		result = append(result, item)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit Space activity read: %w", err)
	}
	return result, nil
}

func decodeActivityParticipants(data []byte) ([]episodes.PresentParticipant, error) {
	var wire []struct {
		ParticipantID string `json:"participant_id"`
		DisplayName   string `json:"display_name"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return nil, fmt.Errorf("decode Space activity participants: %w", err)
	}
	participants := make([]episodes.PresentParticipant, 0, len(wire))
	for _, participant := range wire {
		id, err := utilities.ParseID(participant.ParticipantID)
		if err != nil {
			return nil, fmt.Errorf("decode Space activity Participant ID: %w", err)
		}
		participants = append(participants, episodes.PresentParticipant{ParticipantID: id, DisplayName: participant.DisplayName})
	}
	return participants, nil
}
