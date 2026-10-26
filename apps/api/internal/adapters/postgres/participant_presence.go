package postgres

import (
	"context"
	"crypto/sha256"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Only participant-lease-aware Sync sessions authorize attendance inference.
// Old releases can share the additive schema without expiring live attendees.
func enqueueExpiredParticipantPresence(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, batch int32) (int, error) {
	floor, err := lockPresenceRuntimeFloor(ctx, tx, 2)
	if err != nil {
		return 0, fmt.Errorf("lock participant presence recovery floor: %w", err)
	}
	rooms, err := queries.ClaimExpiredParticipantPresence(ctx, sqlc.ClaimExpiredParticipantPresenceParams{PresenceRecoverAfter: floor, BatchSize: batch})
	if err != nil {
		return 0, fmt.Errorf("claim expired participant presence: %w", err)
	}
	// The API is now an entry-aware Leave writer too. The rollout barrier
	// rejects legacy writers once confirmed entry generations are in use.
	if len(rooms) > 0 {
		if _, err := tx.Exec(ctx, "select set_config('chalk.entry_writer', '1', true)"); err != nil {
			return 0, fmt.Errorf("authorize participant presence leave writer: %w", err)
		}
	}
	count := 0
	for _, room := range rooms {
		tenantID, spaceID, episodeID := utilities.IDFromBytes(room.TenantID.Bytes), utilities.IDFromBytes(room.SpaceID.Bytes), utilities.IDFromBytes(room.EpisodeID.Bytes)
		episode, err := lockLifecycleEpisode(ctx, queries, tenantID, spaceID, episodeID)
		if err != nil {
			return 0, err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			continue
		}
		// Re-read the lease under the authority lock: a reconnect that acquired
		// it first cancels expiry, including one served by another Sync node.
		participants, err := queries.ExpiredParticipantPresence(ctx, sqlc.ExpiredParticipantPresenceParams{
			TenantID: room.TenantID, SpaceID: room.SpaceID, EpisodeID: room.EpisodeID, BatchSize: batch - int32(count),
		})
		if err != nil {
			return 0, fmt.Errorf("recheck expired participant presence: %w", err)
		}
		for _, participant := range participants {
			id, err := utilities.NewID()
			if err != nil {
				return 0, err
			}
			payload := []byte(`{}`)
			_, _, err = createParticipantRemovalOperation(ctx, queries, tx, tenantExternalOperationInput{
				TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
				OperationName:       "participant_leave",
				Request:             episodes.Request{Key: "presence_expired_" + id.String(), Fingerprint: sha256.Sum256(payload)},
				TargetParticipantID: utilities.IDFromBytes(participant.ID.Bytes), TargetParticipantGeneration: participant.Generation,
				JourneyName: "participant.connection_expired", Payload: payload,
			}, participant)
			if err != nil {
				return 0, err
			}
			count++
		}
	}
	return count, nil
}
