package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
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
		for _, expired := range participants {
			participant := expired.Participant
			id, err := utilities.NewID()
			if err != nil {
				return 0, err
			}
			payload, err := json.Marshal(struct {
				EntryGeneration int64 `json:"entryGeneration"`
			}{EntryGeneration: expired.EntryGeneration})
			if err != nil {
				return 0, fmt.Errorf("encode expired participant presence: %w", err)
			}
			attributes := participantPresenceExpiryAttributes(expired)
			expiryCtx, span := otel.Tracer("chalk.presence").Start(ctx, "participant.presence.expire")
			for key, value := range attributes {
				span.SetAttributes(attribute.String(key, value))
			}
			_, _, err = createParticipantRemovalOperation(expiryCtx, queries, tx, tenantExternalOperationInput{
				TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
				OperationName:       "participant_leave",
				Request:             episodes.Request{Key: "presence_expired_" + id.String(), Fingerprint: sha256.Sum256(payload)},
				TargetParticipantID: utilities.IDFromBytes(participant.ID.Bytes), TargetParticipantGeneration: participant.Generation,
				JourneyName: "participant.connection_expired", Payload: payload,
				JourneyAttributes: attributes,
			}, participant)
			if err != nil {
				span.RecordError(err)
			}
			span.SetAttributes(attribute.Bool("reserved", err == nil))
			span.End()
			if err != nil {
				return 0, err
			}
			count++
		}
	}
	return count, nil
}

func participantPresenceExpiryAttributes(expired sqlc.ExpiredParticipantPresenceRow) map[string]string {
	participant := expired.Participant
	attributes := map[string]string{
		"tenant_id":      utilities.IDFromBytes(participant.TenantID.Bytes).String(),
		"episode_id":     utilities.IDFromBytes(participant.EpisodeID.Bytes).String(),
		"participant_id": utilities.IDFromBytes(participant.ID.Bytes).String(),
		"expiry_path":    "missing_lease",
		"joined_age_ms":  strconv.FormatInt(expired.PresenceAgeMs, 10),
	}
	if expired.HasPresenceLease {
		attributes["expiry_path"] = "lease_expired"
		attributes["last_seen_age_ms"] = strconv.FormatInt(expired.PresenceAgeMs, 10)
		delete(attributes, "joined_age_ms")
	}
	return attributes
}
