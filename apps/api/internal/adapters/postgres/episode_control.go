package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const maximumEpisodeDurationExpiredOperationName = "maximum_episode_duration_expired"

func (r EpisodeLifecycleRepository) SetDeadline(ctx context.Context, input episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	var result episodes.ControlRequest
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		// Sync locks the control row before the Episode; lock in that order so the two cannot wait on each other.
		if _, err := lockLifecycleControlRow(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
			return err
		}
		operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, episodes.OperationTenantSetDeadline, input.Request)
		if err == nil {
			return resolveControlRetry(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, operation, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		episode, err := queries.LockDeadlineEpisodeForUpdate(ctx, sqlc.LockDeadlineEpisodeForUpdateParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrEpisodeNotFound
		}
		if err != nil {
			return fmt.Errorf("lock episode deadline: %w", err)
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}
		if _, err := queries.LockPendingDeadlineOperation(ctx, sqlc.LockPendingDeadlineOperationParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
		}); err == nil {
			return episodes.ErrDeadlineChangePending
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock pending deadline operation: %w", err)
		}

		createdAt := timestamp(episode.CreatedAt)
		minimum := createdAt.Add(time.Duration(episodes.MinimumEpisodeDurationSeconds) * time.Second)
		config, err := episodeConfig(episode.ConfigSnapshot)
		if err != nil {
			return err
		}
		if config.MaximumEpisodeDurationSeconds <= 0 {
			return episodes.ErrInvalidMaximumDurationCeiling
		}
		ceiling := createdAt.Add(time.Duration(config.MaximumEpisodeDurationSeconds) * time.Second)
		if input.Deadline.Before(minimum) {
			return episodes.ErrInvalidDeadline
		}
		if input.Deadline.After(ceiling) {
			return episodes.ErrDeadlineExceedsCeiling
		}
		generation := episode.DeadlineGeneration + 1
		payload, err := json.Marshal(struct {
			DeadlineAtMillis   int64 `json:"deadlineAtMs"`
			DeadlineGeneration int64 `json:"deadlineGeneration"`
		}{DeadlineAtMillis: input.Deadline.UnixMilli(), DeadlineGeneration: generation})
		if err != nil {
			return fmt.Errorf("encode deadline operation payload: %w", err)
		}
		operation, err = createTenantExternalOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID,
			OperationName: episodes.OperationTenantSetDeadline, Request: input.Request,
			DeadlineGeneration: generation, JourneyName: "episode.tenant_deadline_requested", Payload: payload,
		})
		if err != nil {
			return err
		}
		result = episodes.ControlRequest{Episode: mapLifecycleEpisode(episode), Operation: mapExternalOperation(operation)}
		return nil
	})
	return result, err
}

func (r EpisodeLifecycleRepository) EnqueueDueEpisodeDeadlines(ctx context.Context, batch int32) (episodes.DeadlineCycle, error) {
	cycle := newDeadlineCycle()
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		if err := enqueueMaximumDurations(ctx, queries, tx, cycle, batch); err != nil {
			return err
		}
		presenceFloor, err := lockPresenceRecoveryFloor(ctx, tx)
		if err != nil {
			return fmt.Errorf("lock presence recovery floor: %w", err)
		}
		departures, err := enqueueExpiredParticipantPresence(ctx, queries, tx, cycle, batch-int32(cycle.result.Enqueued))
		if err != nil {
			return err
		}
		cycle.result.Enqueued += departures
		return enqueueEmptyEpisodeLingers(ctx, queries, tx, cycle, batch, presenceFloor)
	})
	if err != nil {
		return episodes.DeadlineCycle{}, err
	}
	// Deadline claims hold control rows and Episodes. Release those locks before admission
	// expiry takes its own, in the same control-before-Episode order.
	var outcomes []uncollectedAdmissionOutcome
	err = r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		expired, committedOutcomes, err := enqueueDueAdmissionRequests(ctx, queries, tx, batch-int32(cycle.result.Enqueued))
		if err == nil {
			cycle.result.Enqueued += expired
			outcomes = committedOutcomes
		}
		return err
	})
	if err == nil {
		for _, outcome := range outcomes {
			outcome.record()
		}
	}
	return cycle.result, err
}

func enqueueMaximumDurations(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, cycle *deadlineCycle, batch int32) error {
	return claimInPages(func() int32 { return batch - int32(cycle.result.Enqueued) },
		func(excluded []pgtype.UUID, limit int32) ([]sqlc.ClaimDueEpisodeDeadlinesRow, error) {
			due, err := queries.ClaimDueEpisodeDeadlines(ctx, sqlc.ClaimDueEpisodeDeadlinesParams{ExcludedEpisodeIds: excluded, BatchSize: limit})
			if err != nil {
				return nil, fmt.Errorf("claim due episode deadlines: %w", err)
			}
			return due, nil
		},
		func(row sqlc.ClaimDueEpisodeDeadlinesRow) pgtype.UUID { return row.EpisodeID },
		func(row sqlc.ClaimDueEpisodeDeadlinesRow) error {
			return enqueueMaximumDuration(ctx, tx, cycle, row)
		})
}

func enqueueMaximumDuration(ctx context.Context, tx pgx.Tx, cycle *deadlineCycle, row sqlc.ClaimDueEpisodeDeadlinesRow) error {
	tenantID := utilities.IDFromBytes(row.TenantID.Bytes)
	spaceID := utilities.IDFromBytes(row.SpaceID.Bytes)
	episodeID := utilities.IDFromBytes(row.EpisodeID.Bytes)
	request, err := episodes.NewMaximumDurationRequest(tenantID, spaceID, episodeID, row.DeadlineGeneration)
	if err != nil {
		return err
	}
	enqueued := false
	done, err := cycle.step(ctx, tx, deadlinePhase, tenantID, episodeID, func(queries *sqlc.Queries, tx pgx.Tx) error {
		// The claim holds the control row; take the Episode next and recheck it is still the claimed deadline.
		episode, err := lockLifecycleEpisode(ctx, queries, tenantID, spaceID, episodeID)
		if err != nil {
			return err
		}
		if episode.Status != episodes.EpisodeStatusActive || episode.DeadlineGeneration != row.DeadlineGeneration {
			return nil
		}
		_, err = createEndReadyOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
			OperationName: episodes.OperationMaximumDurationExpired, Request: request,
			DeadlineGeneration: row.DeadlineGeneration, JourneyName: "episode.maximum_duration_expired", Payload: request.Payload(),
		})
		enqueued = err == nil
		return err
	})
	if done && enqueued {
		cycle.result.Enqueued++
	}
	return err
}

func enqueueEmptyEpisodeLingers(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, cycle *deadlineCycle, batch int32, presenceFloor pgtype.Timestamptz) error {
	return claimInPages(func() int32 { return batch - int32(cycle.result.Enqueued) },
		func(excluded []pgtype.UUID, limit int32) ([]sqlc.ClaimEmptyEpisodeLingersRow, error) {
			empty, err := queries.ClaimEmptyEpisodeLingers(ctx, sqlc.ClaimEmptyEpisodeLingersParams{
				PresenceRecoverAfter: presenceFloor, ExcludedEpisodeIds: excluded, BatchSize: limit,
			})
			if err != nil {
				return nil, fmt.Errorf("claim empty episode lingers: %w", err)
			}
			return empty, nil
		},
		func(row sqlc.ClaimEmptyEpisodeLingersRow) pgtype.UUID { return row.EpisodeID },
		func(row sqlc.ClaimEmptyEpisodeLingersRow) error {
			return enqueueEmptyEpisodeLinger(ctx, tx, cycle, row, presenceFloor)
		})
}

func enqueueEmptyEpisodeLinger(ctx context.Context, tx pgx.Tx, cycle *deadlineCycle, row sqlc.ClaimEmptyEpisodeLingersRow, presenceFloor pgtype.Timestamptz) error {
	tenantID := utilities.IDFromBytes(row.TenantID.Bytes)
	spaceID := utilities.IDFromBytes(row.SpaceID.Bytes)
	episodeID := utilities.IDFromBytes(row.EpisodeID.Bytes)
	if cycle.fencedByPresence(episodeID) {
		return nil
	}
	ended := false
	done, err := cycle.step(ctx, tx, emptyLingerPhase, tenantID, episodeID, func(queries *sqlc.Queries, tx pgx.Tx) error {
		// The claim holds the control row; take the Episode next, as the recheck below expects.
		if _, err := lockLifecycleEpisode(ctx, queries, tenantID, spaceID, episodeID); err != nil {
			return err
		}
		window, err := queries.EpisodeLingerStillDue(ctx, sqlc.EpisodeLingerStillDueParams{
			TenantID: row.TenantID, SpaceID: row.SpaceID, EpisodeID: row.EpisodeID,
			PresenceRecoverAfter: presenceFloor,
		})
		if err != nil {
			return fmt.Errorf("recheck empty episode linger: %w", err)
		}
		if !window.Due {
			return nil
		}
		request, err := episodes.NewLingerRequest(tenantID, spaceID, episodeID, timestamp(window.EmptySince), int(window.FailedAttempts))
		if err != nil {
			return err
		}
		if _, err := createEndReadyOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
			OperationName: episodes.OperationTenantEndEpisode, Request: request,
			JourneyName: "episode.linger_expired", Payload: request.Payload(),
		}); err != nil {
			return err
		}
		ended = true
		return nil
	})
	if done && ended {
		cycle.result.Enqueued++
	}
	return err
}

var _ episodes.Repository = EpisodeLifecycleRepository{}
var _ episodes.DeadlineSchedulerRepository = EpisodeLifecycleRepository{}
