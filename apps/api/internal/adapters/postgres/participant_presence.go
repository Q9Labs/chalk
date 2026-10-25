package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func enqueueExpiredParticipantPresence(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, batch int32) (int, error) {
	if batch <= 0 {
		return 0, nil
	}
	// Match Sync's entry-aware writer and lock order before Episode authority.
	if _, err := tx.Exec(ctx, `select set_config('chalk.entry_writer','1',true)
        from sync_entry_rollout where singleton for share`); err != nil {
		return 0, fmt.Errorf("configure presence expiry writer: %w", err)
	}
	rows, err := tx.Query(ctx, `select lease.tenant_id, lease.space_id, lease.episode_id, lease.participant_id
  from participant_presence_leases lease
  join participants p on p.id=lease.participant_id and p.generation=lease.participant_generation
  join episodes e on e.id=lease.episode_id
  where lease.expires_at <= now() and p.status='active' and e.status='active'
  order by lease.expires_at, lease.participant_id limit $1`, batch)
	if err != nil {
		return 0, fmt.Errorf("discover expired participant presence: %w", err)
	}
	type candidate struct{ tenant, space, episode, participant pgtype.UUID }
	candidates := make([]candidate, 0, batch)
	for rows.Next() {
		var row candidate
		if err := rows.Scan(&row.tenant, &row.space, &row.episode, &row.participant); err != nil {
			rows.Close()
			return 0, err
		}
		candidates = append(candidates, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	count := 0
	for _, row := range candidates {
		tenant, space, episode, participantID := utilities.IDFromBytes(row.tenant.Bytes), utilities.IDFromBytes(row.space.Bytes), utilities.IDFromBytes(row.episode.Bytes), utilities.IDFromBytes(row.participant.Bytes)
		// Heartbeats and admission take this lock too. Discovery is only a hint:
		// a reconnect on any Sync node must win before we reserve provider work.
		if _, err := lockLifecycleControlRow(ctx, queries, tenant, space, episode); err != nil {
			return 0, err
		}
		currentEpisode, err := lockLifecycleEpisode(ctx, queries, tenant, space, episode)
		if err != nil {
			return 0, err
		}
		if currentEpisode.Status != episodes.EpisodeStatusActive {
			continue
		}
		participant, err := lockLifecycleParticipant(ctx, queries, tenant, space, episode, participantID)
		if err != nil {
			return 0, err
		}
		if participant.Status != episodes.ParticipantStatusActive {
			continue
		}
		var expiry pgtype.Timestamptz
		var entryGeneration int64
		err = tx.QueryRow(ctx, `select lease.expires_at, coalesce(seat.confirmed_entry_generation,0)
   from participant_presence_leases lease left join participant_join_seats seat
     on seat.participant_id=lease.participant_id and seat.generation=lease.participant_generation
   where lease.tenant_id=$1 and lease.space_id=$2 and lease.episode_id=$3 and lease.participant_id=$4
   and lease.participant_generation=$5 and lease.expires_at <= clock_timestamp()`, row.tenant, row.space, row.episode, row.participant, participant.Generation).Scan(&expiry, &entryGeneration)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("recheck expired participant presence: %w", err)
		}
		key := fmt.Sprintf("presence-expired-%s-%d-%d", participantID, participant.Generation, expiry.Time.UnixMicro())
		payload, err := json.Marshal(struct {
			EntryGeneration int64 `json:"entryGeneration"`
		}{EntryGeneration: entryGeneration})
		if err != nil {
			return 0, fmt.Errorf("encode presence expiry leave: %w", err)
		}
		if _, _, err := createParticipantRemovalOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: tenant, SpaceID: space, EpisodeID: episode, OperationName: "participant_leave",
			Request:             episodes.Request{Key: key, Fingerprint: sha256.Sum256([]byte(key))},
			TargetParticipantID: participantID, TargetParticipantGeneration: participant.Generation,
			JourneyName: "participant.presence_expired", Payload: payload,
		}, participant); err != nil {
			return 0, err
		}
		// A terminal provider failure can restore active. Keep a fresh window
		// so that disconnected participant is retried rather than stranded.
		if _, err := tx.Exec(ctx, `update participant_presence_leases set expires_at=clock_timestamp()+interval '120 seconds' where participant_id=$1`, row.participant); err != nil {
			return 0, err
		}
		count++
	}
	return count, nil
}
