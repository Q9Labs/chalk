package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeRecoveryDB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
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
	nodes, incarnations := make([]string, 0, len(next.PreviousAllocations)), make([]string, 0, len(next.PreviousAllocations))
	for _, owed := range next.Retirements() {
		nodes, incarnations = append(nodes, owed.Node), append(incarnations, owed.Incarnation)
	}
	// One statement: the move and the retirement debts it creates commit together or not at all.
	var moved int
	err = r.db.QueryRow(ctx, `
with moved as (
    update episodes
    set config_snapshot = jsonb_set(config_snapshot, '{media_plane_binding}', $3::jsonb)
    where tenant_id = $1 and id = $2 and status = 'active'
      and config_snapshot->'media_plane_binding'->>'provider' = 'chalk_sfu'
      and coalesce((config_snapshot->'media_plane_binding'->>'generation')::bigint, 0) = $4
    returning tenant_id, id
), owed as (
    insert into sfu_retirement_debts (tenant_id, episode_id, node, incarnation, generation)
    select moved.tenant_id, moved.id, owed.node, owed.incarnation, $5
    from moved, unnest($6::text[], $7::text[]) as owed(node, incarnation)
    on conflict (tenant_id, episode_id, node, incarnation)
    do update set generation = greatest(sfu_retirement_debts.generation, excluded.generation), next_attempt_at = now()
)
select count(*) from moved`,
		uuid(tenantID), uuid(episodeID), encoded, from, next.Generation, nodes, incarnations).Scan(&moved)
	if err != nil {
		return mediaplane.Binding{}, fmt.Errorf("move Episode media plane binding: %w", err)
	}
	if moved == 1 {
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

// RecordRetirementDebts adds the debts, keeping the higher generation of one that exists.
func (r EpisodeRecovery) RecordRetirementDebts(ctx context.Context, debts []mediaplane.RetirementDebt) error {
	for _, debt := range debts {
		_, err := r.db.Exec(ctx, `
insert into sfu_retirement_debts (tenant_id, episode_id, node, incarnation, generation)
values ($1, $2, $3, $4, $5)
on conflict (tenant_id, episode_id, node, incarnation)
do update set generation = greatest(sfu_retirement_debts.generation, excluded.generation)`,
			uuid(debt.TenantID), uuid(debt.EpisodeID), debt.Allocation.Node, debt.Allocation.Incarnation, debt.Generation)
		if err != nil {
			return fmt.Errorf("record retirement debt: %w", err)
		}
	}
	return nil
}

// ClaimRetirementDebts returns up to limit debts that are due and pushes each one's next attempt
// out by 5 seconds doubling to 5 minutes, so a node that stays silent costs one call per backoff
// and concurrent workers skip rows another one has locked.
func (r EpisodeRecovery) ClaimRetirementDebts(ctx context.Context, limit int) ([]mediaplane.RetirementDebt, error) {
	rows, err := r.db.Query(ctx, `
update sfu_retirement_debts debt
set attempts = debt.attempts + 1,
    next_attempt_at = now() + make_interval(secs => least(300, 5 * power(2, least(debt.attempts, 6))))
where (debt.tenant_id, debt.episode_id, debt.node, debt.incarnation) in (
    select tenant_id, episode_id, node, incarnation from sfu_retirement_debts
    where next_attempt_at <= now()
    order by next_attempt_at
    limit $1
    for update skip locked)
returning debt.tenant_id, debt.episode_id, debt.node, debt.incarnation, debt.generation`, limit)
	if err != nil {
		return nil, fmt.Errorf("claim retirement debts: %w", err)
	}
	defer rows.Close()
	var debts []mediaplane.RetirementDebt
	for rows.Next() {
		var tenantID, episodeID pgtype.UUID
		var debt mediaplane.RetirementDebt
		if err := rows.Scan(&tenantID, &episodeID, &debt.Allocation.Node, &debt.Allocation.Incarnation, &debt.Generation); err != nil {
			return nil, fmt.Errorf("read retirement debt: %w", err)
		}
		debt.TenantID, debt.EpisodeID = nullableID(tenantID), nullableID(episodeID)
		debts = append(debts, debt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read retirement debts: %w", err)
	}
	return debts, nil
}

// SettleRetirementDebt deletes the debt, unless a higher generation was recorded after it was claimed.
func (r EpisodeRecovery) SettleRetirementDebt(ctx context.Context, debt mediaplane.RetirementDebt) error {
	_, err := r.db.Exec(ctx, `
delete from sfu_retirement_debts
where tenant_id = $1 and episode_id = $2 and node = $3 and incarnation = $4 and generation <= $5`,
		uuid(debt.TenantID), uuid(debt.EpisodeID), debt.Allocation.Node, debt.Allocation.Incarnation, debt.Generation)
	if err != nil {
		return fmt.Errorf("settle retirement debt: %w", err)
	}
	return nil
}

// RetirementBacklog counts the unpaid retirement debts and ages the oldest one. A debt is deleted
// only when its node acknowledged, answered with a new boot, or left the configuration, so what
// remains is cleanup the API still owes.
func (r EpisodeRecovery) RetirementBacklog(ctx context.Context) (int, time.Duration, error) {
	var count int
	var oldest float64
	err := r.db.QueryRow(ctx, `
select count(*), coalesce(extract(epoch from now() - min(created_at)), 0)::float8 from sfu_retirement_debts`).Scan(&count, &oldest)
	if err != nil {
		return 0, 0, fmt.Errorf("read retirement backlog: %w", err)
	}
	return count, time.Duration(oldest * float64(time.Second)), nil
}
