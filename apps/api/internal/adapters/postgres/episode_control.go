package postgres

import (
	"bytes"
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

type tenantExternalOperationInput struct {
	TenantID                    utilities.ID
	SpaceID                     utilities.ID
	EpisodeID                   utilities.ID
	OperationName               string
	Request                     episodes.Request
	TargetParticipantID         utilities.ID
	TargetParticipantGeneration int64
	DeadlineGeneration          int64
	RecordingID                 utilities.ID
	FenceActive                 bool
	JourneyName                 string
	Payload                     []byte
}

func (r EpisodeLifecycleRepository) SetDeadline(ctx context.Context, input episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	var result episodes.ControlRequest
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
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

func (r EpisodeLifecycleRepository) EnqueueDueEpisodeDeadlines(ctx context.Context, batch int32) (int, error) {
	count := 0
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		due, err := queries.ClaimDueEpisodeDeadlines(ctx, batch)
		if err != nil {
			return fmt.Errorf("claim due episode deadlines: %w", err)
		}
		for _, row := range due {
			tenantID := utilities.IDFromBytes(row.TenantID.Bytes)
			spaceID := utilities.IDFromBytes(row.SpaceID.Bytes)
			episodeID := utilities.IDFromBytes(row.EpisodeID.Bytes)
			request, err := episodes.NewMaximumDurationRequest(tenantID, spaceID, episodeID, row.DeadlineGeneration)
			if err != nil {
				return err
			}
			if _, err := createEndReadyOperation(ctx, queries, tx, tenantExternalOperationInput{
				TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
				OperationName: episodes.OperationMaximumDurationExpired, Request: request,
				DeadlineGeneration: row.DeadlineGeneration, JourneyName: "episode.maximum_duration_expired", Payload: request.Payload(),
			}); err != nil {
				return err
			}
			count++
		}
		return nil
	})
	return count, err
}

func lockTenantExternalOperation(ctx context.Context, queries *sqlc.Queries, tenantID, spaceID, episodeID utilities.ID, operationName string, request episodes.Request) (sqlc.SyncExternalOperation, error) {
	operation, err := queries.LockTenantExternalOperationForRequest(ctx, sqlc.LockTenantExternalOperationForRequestParams{
		TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: uuid(episodeID), OperationName: operationName, RequestKey: request.Key,
	})
	if err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	if !bytes.Equal(operation.RequestFingerprint, request.Fingerprint[:]) {
		return sqlc.SyncExternalOperation{}, episodes.ErrIdempotencyConflict
	}
	return operation, nil
}

func createTenantExternalOperation(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input tenantExternalOperationInput) (sqlc.SyncExternalOperation, error) {
	operationID, err := utilities.NewID()
	if err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("create episode external operation id: %w", err)
	}
	journey, err := lifecycleJourneyFromContext(ctx)
	if err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	if err := persistLifecycleJourneyRoot(ctx, tx, journey, input.JourneyName); err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	operation, err := queries.CreateTenantExternalOperation(ctx, sqlc.CreateTenantExternalOperationParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
		ExternalOperationID: uuid(operationID), RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:],
		OperationName: input.OperationName, TargetParticipantID: uuid(input.TargetParticipantID),
		TargetParticipantGeneration: optionalInt8(input.TargetParticipantGeneration), DeadlineGeneration: optionalInt8(input.DeadlineGeneration),
		RecordingID: uuid(input.RecordingID), FenceActive: input.FenceActive,
		JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID),
		ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID), Payload: jsonBytes(input.Payload),
	})
	if err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("create %s external operation: %w", input.OperationName, err)
	}
	return operation, nil
}

func createEndReadyOperation(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input tenantExternalOperationInput) (sqlc.SyncExternalOperation, error) {
	participants, err := queries.LockActiveParticipantsForTenantEnd(ctx, sqlc.LockActiveParticipantsForTenantEndParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
	})
	if err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("lock active participants for episode end: %w", err)
	}
	recordingID, err := queries.LockActiveRecordingForTenantEnd(ctx, sqlc.LockActiveRecordingForTenantEndParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
	})
	if err == nil {
		input.RecordingID = nullableID(recordingID)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("lock active recording for episode end: %w", err)
	}
	input.FenceActive = true
	operation, err := createTenantExternalOperation(ctx, queries, tx, input)
	if err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	for _, participant := range participants {
		for _, source := range []string{"microphone", "camera", "screen"} {
			owner, err := queries.CreateTenantEndPublicationFence(ctx, sqlc.CreateTenantEndPublicationFenceParams{
				TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
				ParticipantID: participant.ID, ParticipantGeneration: participant.Generation,
				Source: source, ExternalOperationID: operation.ExternalOperationID,
			})
			if err != nil || owner != operation.ExternalOperationID {
				if err == nil {
					err = episodes.ErrEpisodeControlBusy
				}
				return sqlc.SyncExternalOperation{}, fmt.Errorf("install episode end publication fence: %w", err)
			}
		}
	}
	if _, err := queries.FailPendingTenantControlOperationsForEnd(ctx, sqlc.FailPendingTenantControlOperationsForEndParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
	}); err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("settle pending episode control operations: %w", err)
	}
	if _, err := queries.MarkTenantExternalEpisodeEnding(ctx, sqlc.MarkTenantExternalEpisodeEndingParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
	}); errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SyncExternalOperation{}, episodes.ErrEpisodeNotActive
	} else if err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("mark tenant external episode ending: %w", err)
	}
	return operation, nil
}

func createParticipantRemovalOperation(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input tenantExternalOperationInput, participant sqlc.Participant) (sqlc.SyncExternalOperation, sqlc.Participant, error) {
	input.FenceActive = true
	operation, err := createTenantExternalOperation(ctx, queries, tx, input)
	if err != nil {
		return sqlc.SyncExternalOperation{}, sqlc.Participant{}, err
	}
	for _, source := range []string{"microphone", "camera", "screen"} {
		owner, err := queries.CreateTenantEndPublicationFence(ctx, sqlc.CreateTenantEndPublicationFenceParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
			ParticipantID: participant.ID, ParticipantGeneration: participant.Generation,
			Source: source, ExternalOperationID: operation.ExternalOperationID,
		})
		if err != nil || owner != operation.ExternalOperationID {
			if err == nil {
				err = episodes.ErrEpisodeControlBusy
			}
			return sqlc.SyncExternalOperation{}, sqlc.Participant{}, fmt.Errorf("install participant removal publication fence: %w", err)
		}
	}
	participant, err = queries.MarkLifecycleParticipantLeaving(ctx, sqlc.MarkLifecycleParticipantLeavingParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
		ParticipantID: participant.ID, ParticipantGeneration: participant.Generation,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SyncExternalOperation{}, sqlc.Participant{}, episodes.ErrParticipantNotActive
	}
	if err != nil {
		return sqlc.SyncExternalOperation{}, sqlc.Participant{}, fmt.Errorf("mark removal participant leaving: %w", err)
	}
	return operation, participant, nil
}

func resolveControlRetry(ctx context.Context, queries *sqlc.Queries, tenantID, spaceID, episodeID utilities.ID, operation sqlc.SyncExternalOperation, result *episodes.ControlRequest) error {
	episode, err := lockLifecycleEpisode(ctx, queries, tenantID, spaceID, episodeID)
	if err != nil {
		return err
	}
	*result = episodes.ControlRequest{Episode: mapLifecycleEpisode(episode), Operation: mapExternalOperation(operation)}
	return nil
}

func mapExternalOperation(row sqlc.SyncExternalOperation) episodes.ExternalOperation {
	return episodes.ExternalOperation{
		ID: utilities.IDFromBytes(row.ExternalOperationID.Bytes), RequestKey: row.RequestKey, OperationName: row.OperationName,
		TargetParticipantID: nullableID(row.TargetParticipantID), TargetGeneration: nullableInt64(row.TargetParticipantGeneration),
		DeadlineGeneration: nullableInt64(row.DeadlineGeneration), Status: row.Status, CreatedAt: timestamp(row.CreatedAt),
	}
}

func mapExternalOperationIntent(row sqlc.SyncExternalOperation) episodes.Intent {
	operation := mapExternalOperation(row)
	return episodes.Intent{
		ID: operation.ID, TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID: utilities.IDFromBytes(row.EpisodeID.Bytes), RequestKey: operation.RequestKey, IntentName: operation.OperationName,
		ParticipantID: operation.TargetParticipantID, ParticipantGeneration: operation.TargetGeneration,
		Status: operation.Status, CreatedAt: operation.CreatedAt,
	}
}

func optionalInt8(value int64) pgtype.Int8 {
	if value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

var _ episodes.Repository = EpisodeLifecycleRepository{}
var _ episodes.DeadlineSchedulerRepository = EpisodeLifecycleRepository{}
