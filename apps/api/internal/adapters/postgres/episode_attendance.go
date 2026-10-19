package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) GetEpisodeAttendance(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) ([]episodes.AttendanceParticipant, error) {
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin Episode attendance read: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := sqlc.New(tx).GetEpisodeAttendance(ctx, sqlc.GetEpisodeAttendanceParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: uuid(episodeID)})
	if err != nil {
		return nil, fmt.Errorf("get Episode attendance: %w", err)
	}
	if len(rows) == 0 {
		return nil, episodes.ErrEpisodeNotFound
	}
	result := make([]episodes.AttendanceParticipant, 0, len(rows))
	for _, row := range rows {
		if !row.ParticipantID.Valid {
			continue
		}
		participant := episodes.AttendanceParticipant{
			ParticipantID: utilities.IDFromBytes(row.ParticipantID.Bytes), DisplayName: nullableString(row.DisplayName),
			IdentityKind: row.IdentityKind, ExternalID: nullableText(row.ExternalID), FirstJoinedAt: timestamp(row.FirstJoinedAt), LastLeftAt: nullableTimestamp(row.LastLeftAt),
		}
		if row.LeftReason != "" {
			participant.LeftReason = &row.LeftReason
		}
		result = append(result, participant)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit Episode attendance read: %w", err)
	}
	return result, nil
}
