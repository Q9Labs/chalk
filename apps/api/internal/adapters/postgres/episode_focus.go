package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) GetEpisodeFocus(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) (episodes.FocusArtifact, error) {
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("begin focus artifact read: %w", err)
	}
	defer tx.Rollback(ctx)

	var startedAt, endedAt pgtype.Timestamptz
	err = tx.QueryRow(ctx, `select started_at, coalesce(ended_at, now()) from episodes where tenant_id=$1 and space_id=$2 and id=$3`, uuid(tenantID), uuid(spaceID), uuid(episodeID)).Scan(&startedAt, &endedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return episodes.FocusArtifact{}, episodes.ErrEpisodeNotFound
	}
	if err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("get focus artifact episode: %w", err)
	}
	artifact := episodes.FocusArtifact{EpisodeID: episodeID, Participants: []episodes.FocusParticipant{}, AllowWindows: []episodes.FocusAllowWindow{}}

	scope := []any{uuid(tenantID), uuid(spaceID), uuid(episodeID)}
	participantIndex, err := readFocusParticipants(ctx, tx, scope, startedAt.Time, endedAt.Time, &artifact)
	if err != nil {
		return episodes.FocusArtifact{}, err
	}
	if err := readFocusIntervals(ctx, tx, scope, participantIndex, &artifact); err != nil {
		return episodes.FocusArtifact{}, err
	}
	if err := readFocusStepAways(ctx, tx, scope, participantIndex, &artifact); err != nil {
		return episodes.FocusArtifact{}, err
	}
	if err := readFocusAllowWindows(ctx, tx, scope, &artifact); err != nil {
		return episodes.FocusArtifact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("commit focus artifact read: %w", err)
	}
	return artifact, nil
}

func readFocusParticipants(ctx context.Context, tx pgx.Tx, scope []any, startedAt, endedAt time.Time, artifact *episodes.FocusArtifact) (map[[16]byte]int, error) {
	rows, err := tx.Query(ctx, `select id, name from participants where tenant_id=$1 and space_id=$2 and episode_id=$3 order by joined_at, id`, scope...)
	if err != nil {
		return nil, fmt.Errorf("list focus artifact participants: %w", err)
	}
	defer rows.Close()
	index := map[[16]byte]int{}
	for rows.Next() {
		var id pgtype.UUID
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fmt.Errorf("scan focus artifact participant: %w", err)
		}
		index[id.Bytes] = len(artifact.Participants)
		artifact.Participants = append(artifact.Participants, episodes.FocusParticipant{
			ParticipantID: utilities.IDFromBytes(id.Bytes), DisplayName: name,
			EpisodeStartsAt: startedAt, EpisodeEndsAt: endedAt,
			Intervals: []episodes.FocusInterval{}, StepAways: []episodes.FocusStepAway{},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read focus artifact participants: %w", err)
	}
	return index, nil
}

func readFocusIntervals(ctx context.Context, tx pgx.Tx, scope []any, index map[[16]byte]int, artifact *episodes.FocusArtifact) error {
	rows, err := tx.Query(ctx, `select participant_id, state, windowed, started_at, ended_at from episode_focus_intervals where tenant_id=$1 and space_id=$2 and episode_id=$3 order by participant_id, started_at`, scope...)
	if err != nil {
		return fmt.Errorf("list focus intervals: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var participantID pgtype.UUID
		var interval episodes.FocusInterval
		if err := rows.Scan(&participantID, &interval.State, &interval.Windowed, &interval.StartedAt, &interval.EndedAt); err != nil {
			return fmt.Errorf("scan focus interval: %w", err)
		}
		if position, ok := index[participantID.Bytes]; ok {
			artifact.Participants[position].Intervals = append(artifact.Participants[position].Intervals, interval)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read focus intervals: %w", err)
	}
	return nil
}

func readFocusStepAways(ctx context.Context, tx pgx.Tx, scope []any, index map[[16]byte]int, artifact *episodes.FocusArtifact) error {
	rows, err := tx.Query(ctx, `select participant_id, reason, started_at, ended_at from episode_focus_step_aways where tenant_id=$1 and space_id=$2 and episode_id=$3 order by participant_id, started_at`, scope...)
	if err != nil {
		return fmt.Errorf("list focus step aways: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var participantID pgtype.UUID
		var step episodes.FocusStepAway
		var ended pgtype.Timestamptz
		if err := rows.Scan(&participantID, &step.Reason, &step.StartedAt, &ended); err != nil {
			return fmt.Errorf("scan focus step away: %w", err)
		}
		step.EndedAt = nullableTimestamp(ended)
		if position, ok := index[participantID.Bytes]; ok {
			artifact.Participants[position].StepAways = append(artifact.Participants[position].StepAways, step)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read focus step aways: %w", err)
	}
	return nil
}

func readFocusAllowWindows(ctx context.Context, tx pgx.Tx, scope []any, artifact *episodes.FocusArtifact) error {
	rows, err := tx.Query(ctx, `select actor_participant_id, started_at, ends_at, ended_at from episode_focus_allow_windows where tenant_id=$1 and space_id=$2 and episode_id=$3 order by started_at`, scope...)
	if err != nil {
		return fmt.Errorf("list focus allow windows: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var actor pgtype.UUID
		var ended pgtype.Timestamptz
		var window episodes.FocusAllowWindow
		if err := rows.Scan(&actor, &window.StartedAt, &window.EndsAt, &ended); err != nil {
			return fmt.Errorf("scan focus allow window: %w", err)
		}
		window.ActorParticipantID = utilities.IDFromBytes(actor.Bytes)
		window.EndedAt = nullableTimestamp(ended)
		artifact.AllowWindows = append(artifact.AllowWindows, window)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read focus allow windows: %w", err)
	}
	return nil
}
