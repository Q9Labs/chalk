package postgres

import (
	"context"
	"errors"
	"fmt"

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

	participantRows, err := tx.Query(ctx, `select id, name from participants where tenant_id=$1 and space_id=$2 and episode_id=$3 order by joined_at, id`, uuid(tenantID), uuid(spaceID), uuid(episodeID))
	if err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("list focus artifact participants: %w", err)
	}
	participantIndex := map[[16]byte]int{}
	for participantRows.Next() {
		var id pgtype.UUID
		var name string
		if err := participantRows.Scan(&id, &name); err != nil {
			participantRows.Close()
			return episodes.FocusArtifact{}, fmt.Errorf("scan focus artifact participant: %w", err)
		}
		participantIndex[id.Bytes] = len(artifact.Participants)
		artifact.Participants = append(artifact.Participants, episodes.FocusParticipant{
			ParticipantID: utilities.IDFromBytes(id.Bytes), DisplayName: name,
			EpisodeStartsAt: startedAt.Time, EpisodeEndsAt: endedAt.Time,
			Intervals: []episodes.FocusInterval{}, StepAways: []episodes.FocusStepAway{},
		})
	}
	participantRows.Close()
	if err := participantRows.Err(); err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("read focus artifact participants: %w", err)
	}

	intervalRows, err := tx.Query(ctx, `select participant_id, state, windowed, started_at, ended_at from episode_focus_intervals where tenant_id=$1 and space_id=$2 and episode_id=$3 order by participant_id, started_at`, uuid(tenantID), uuid(spaceID), uuid(episodeID))
	if err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("list focus intervals: %w", err)
	}
	for intervalRows.Next() {
		var participantID pgtype.UUID
		var interval episodes.FocusInterval
		if err := intervalRows.Scan(&participantID, &interval.State, &interval.Windowed, &interval.StartedAt, &interval.EndedAt); err != nil {
			intervalRows.Close()
			return episodes.FocusArtifact{}, fmt.Errorf("scan focus interval: %w", err)
		}
		if index, ok := participantIndex[participantID.Bytes]; ok {
			artifact.Participants[index].Intervals = append(artifact.Participants[index].Intervals, interval)
		}
	}
	intervalRows.Close()
	if err := intervalRows.Err(); err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("read focus intervals: %w", err)
	}

	stepRows, err := tx.Query(ctx, `select participant_id, reason, started_at, ended_at from episode_focus_step_aways where tenant_id=$1 and space_id=$2 and episode_id=$3 order by participant_id, started_at`, uuid(tenantID), uuid(spaceID), uuid(episodeID))
	if err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("list focus step aways: %w", err)
	}
	for stepRows.Next() {
		var participantID pgtype.UUID
		var step episodes.FocusStepAway
		var ended pgtype.Timestamptz
		if err := stepRows.Scan(&participantID, &step.Reason, &step.StartedAt, &ended); err != nil {
			stepRows.Close()
			return episodes.FocusArtifact{}, fmt.Errorf("scan focus step away: %w", err)
		}
		step.EndedAt = nullableTimestamp(ended)
		if index, ok := participantIndex[participantID.Bytes]; ok {
			artifact.Participants[index].StepAways = append(artifact.Participants[index].StepAways, step)
		}
	}
	stepRows.Close()
	if err := stepRows.Err(); err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("read focus step aways: %w", err)
	}

	allowRows, err := tx.Query(ctx, `select actor_participant_id, started_at, ends_at, ended_at from episode_focus_allow_windows where tenant_id=$1 and space_id=$2 and episode_id=$3 order by started_at`, uuid(tenantID), uuid(spaceID), uuid(episodeID))
	if err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("list focus allow windows: %w", err)
	}
	for allowRows.Next() {
		var actor pgtype.UUID
		var ended pgtype.Timestamptz
		var window episodes.FocusAllowWindow
		if err := allowRows.Scan(&actor, &window.StartedAt, &window.EndsAt, &ended); err != nil {
			allowRows.Close()
			return episodes.FocusArtifact{}, fmt.Errorf("scan focus allow window: %w", err)
		}
		window.ActorParticipantID = utilities.IDFromBytes(actor.Bytes)
		window.EndedAt = nullableTimestamp(ended)
		artifact.AllowWindows = append(artifact.AllowWindows, window)
	}
	allowRows.Close()
	if err := allowRows.Err(); err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("read focus allow windows: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return episodes.FocusArtifact{}, fmt.Errorf("commit focus artifact read: %w", err)
	}
	return artifact, nil
}
