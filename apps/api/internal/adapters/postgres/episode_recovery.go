package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeRecoveryDB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// EpisodeRecovery is the durable side of whole-Episode recovery: the Episode's size and the
// compare-and-set of its media plane binding. The binding lives in episodes.config_snapshot,
// which is immutable except for this move; the database trigger accepts only a chalk_sfu
// placement change that advances the binding generation by exactly one.
type EpisodeRecovery struct{ db episodeRecoveryDB }

func NewEpisodeRecovery(db episodeRecoveryDB) EpisodeRecovery { return EpisodeRecovery{db: db} }

// LiveParticipants counts the Participants that hold a place in the Episode: joining or active.
// A leaving or left Participant does not rejoin.
func (r EpisodeRecovery) LiveParticipants(ctx context.Context, tenantID, episodeID utilities.ID) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `select count(*) from participants where tenant_id = $1 and episode_id = $2 and status in ('joining', 'active')`, uuid(tenantID), uuid(episodeID)).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count Episode Participants: %w", err)
	}
	return count, nil
}

// Binding reads the Episode's media plane binding. It is nil for an Episode without one.
func (r EpisodeRecovery) Binding(ctx context.Context, tenantID, episodeID utilities.ID) (*mediaplane.Binding, error) {
	var raw []byte
	err := r.db.QueryRow(ctx, `select config_snapshot->'media_plane_binding' from episodes where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(episodeID)).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, episodes.ErrEpisodeNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read Episode media plane binding: %w", err)
	}
	var binding *mediaplane.Binding
	if err := json.Unmarshal(raw, &binding); err != nil {
		return nil, fmt.Errorf("decode Episode media plane binding: %w", err)
	}
	if binding != nil {
		if err := binding.Validate(); err != nil {
			return nil, err
		}
	}
	return binding, nil
}

// MoveBinding replaces the binding of an active chalk_sfu Episode with next, only while the
// stored binding is at generation from. One writer wins: a second UPDATE waits for the row
// lock, re-reads the generation and matches nothing. The loser gets the stored binding with
// mediaplane.ErrBindingStale and follows it. An Episode that is not active refuses the move,
// because an ending Episode has nothing left to recover.
func (r EpisodeRecovery) MoveBinding(ctx context.Context, tenantID, episodeID utilities.ID, from int64, next mediaplane.Binding) (mediaplane.Binding, error) {
	if err := next.Validate(); err != nil || next.Generation != from+1 {
		return mediaplane.Binding{}, mediaplane.ErrInvalidBinding
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		return mediaplane.Binding{}, fmt.Errorf("encode Episode media plane binding: %w", err)
	}
	tag, err := r.db.Exec(ctx, `
update episodes
set config_snapshot = jsonb_set(config_snapshot, '{media_plane_binding}', $3::jsonb)
where tenant_id = $1 and id = $2 and status = 'active'
  and config_snapshot->'media_plane_binding'->>'provider' = 'chalk_sfu'
  and coalesce((config_snapshot->'media_plane_binding'->>'generation')::bigint, 0) = $4`,
		uuid(tenantID), uuid(episodeID), encoded, from)
	if err != nil {
		return mediaplane.Binding{}, fmt.Errorf("move Episode media plane binding: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return next, nil
	}
	var status string
	var raw []byte
	err = r.db.QueryRow(ctx, `select status, config_snapshot->'media_plane_binding' from episodes where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(episodeID)).Scan(&status, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return mediaplane.Binding{}, episodes.ErrEpisodeNotFound
	}
	if err != nil {
		return mediaplane.Binding{}, fmt.Errorf("read Episode media plane binding after a lost move: %w", err)
	}
	if status != episodes.EpisodeStatusActive {
		return mediaplane.Binding{}, episodes.ErrEpisodeNotActive
	}
	var current mediaplane.Binding
	if err := json.Unmarshal(raw, &current); err != nil || current.Validate() != nil {
		return mediaplane.Binding{}, fmt.Errorf("decode Episode media plane binding after a lost move: %w", mediaplane.ErrInvalidBinding)
	}
	return current, mediaplane.ErrBindingStale
}
