package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

// Two minutes covers the supported 60-second SDK startup plus admission and response time.
func createParticipantJoinSeat(ctx context.Context, tx pgx.Tx, participant sqlc.Participant) error {
	_, err := tx.Exec(ctx, `insert into participant_join_seats
        (tenant_id, space_id, episode_id, participant_id, generation, state, expires_at)
        values ($1,$2,$3,$4,$5,'pending',now()+interval '2 minutes')`,
		participant.TenantID, participant.SpaceID, participant.EpisodeID, participant.ID, participant.Generation)
	if err != nil {
		return fmt.Errorf("create pending participant join: %w", err)
	}
	return nil
}

// The caller already holds the Episode authority lock and participant lock.
func retryParticipantJoinSeat(ctx context.Context, tx pgx.Tx, participant sqlc.Participant) error {
	var state string
	err := tx.QueryRow(ctx, `select transition_participant_join_seat($1,$2,$3,$4,$5,'retry')`,
		participant.TenantID, participant.SpaceID, participant.EpisodeID, participant.ID, participant.Generation).Scan(&state)
	if err != nil {
		return fmt.Errorf("retry pending participant join: %w", err)
	}
	switch state {
	case "legacy", "pending", "joined":
		return nil
	case "episode_ended":
		return episodes.ErrEpisodeNotActive
	case "capacity_exceeded":
		return episodes.ErrCapacityExceeded
	default:
		return episodes.ErrParticipantNotActive
	}
}

func (r EpisodeLifecycleRepository) CancelParticipantJoin(ctx context.Context, input episodes.CancelParticipantJoinInput) (bool, error) {
	var state string
	err := r.transaction(ctx, func(_ *sqlc.Queries, tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `select transition_participant_join_seat($1,$2,$3,$4,$5,'cancel',$6)`,
			uuid(input.TenantID), uuid(input.SpaceID), uuid(input.EpisodeID), uuid(input.ParticipantID), input.ParticipantGeneration, input.MediaConnectionID).Scan(&state)
		if err != nil {
			return fmt.Errorf("cancel pending participant join: %w", err)
		}
		return nil
	})
	return state == "cancelled" || state == "expired" || state == "left" || state == "stale", err
}
