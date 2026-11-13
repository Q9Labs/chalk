package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

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
	JourneyAttributes           map[string]string
	Payload                     []byte
}

// The shared row lock serializes deadline claims with Sync startup. sqlc does
// not model pg_locks; the dedicated Sync session holds advisory (1128811595, 1).
func lockPresenceRecoveryFloor(ctx context.Context, tx pgx.Tx) (pgtype.Timestamptz, error) {
	return lockPresenceRuntimeFloor(ctx, tx, 1)
}

func lockPresenceRuntimeFloor(ctx context.Context, tx pgx.Tx, witness int) (pgtype.Timestamptz, error) {
	var floor pgtype.Timestamptz
	err := tx.QueryRow(ctx, `select (case when exists (
    select 1 from pg_locks where locktype='advisory' and classid=1128811595
        and objid=$1::oid and objsubid=2 and mode='ShareLock' and granted
        and database=(select oid from pg_database where datname=current_database())
) then recover_after end)::timestamptz as recover_after
from sync_presence_runtime where singleton for share;`, witness).Scan(&floor)
	return floor, err
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
	if err := persistLifecycleJourneyRootWith(ctx, tx, journey, input.JourneyName, input.JourneyAttributes); err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	operation, err := queries.CreateTenantExternalOperation(ctx, sqlc.CreateTenantExternalOperationParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
		ExternalOperationID: uuid(operationID), RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:],
		OperationName: operationNameForStorage(input.OperationName), TargetParticipantID: uuid(input.TargetParticipantID),
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

func operationNameForStorage(operationName string) string {
	if operationName == episodes.OperationMaximumDurationExpired {
		return maximumEpisodeDurationExpiredOperationName
	}
	return operationName
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
		if err := installPublicationFences(ctx, queries, input, participant.ID, participant.Generation, operation, "episode end"); err != nil {
			return sqlc.SyncExternalOperation{}, err
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

// installPublicationFences stops the participant publishing microphone, camera or screen under the
// operation. Another operation that already owns a fence makes this one busy.
func installPublicationFences(ctx context.Context, queries *sqlc.Queries, input tenantExternalOperationInput, participantID pgtype.UUID, generation int64, operation sqlc.SyncExternalOperation, purpose string) error {
	for _, source := range []string{"microphone", "camera", "screen"} {
		owner, err := queries.CreateTenantEndPublicationFence(ctx, sqlc.CreateTenantEndPublicationFenceParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
			ParticipantID: participantID, ParticipantGeneration: generation,
			Source: source, ExternalOperationID: operation.ExternalOperationID,
		})
		if err != nil || owner != operation.ExternalOperationID {
			if err == nil || errors.Is(err, pgx.ErrNoRows) {
				err = episodes.ErrEpisodeControlBusy
			}
			return fmt.Errorf("install %s publication fence: %w", purpose, err)
		}
	}
	return nil
}

func createParticipantRemovalOperation(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input tenantExternalOperationInput, participant sqlc.Participant) (sqlc.SyncExternalOperation, sqlc.Participant, error) {
	input.FenceActive = true
	operation, err := createTenantExternalOperation(ctx, queries, tx, input)
	if err != nil {
		return sqlc.SyncExternalOperation{}, sqlc.Participant{}, err
	}
	if err := installPublicationFences(ctx, queries, input, participant.ID, participant.Generation, operation, "participant removal"); err != nil {
		return sqlc.SyncExternalOperation{}, sqlc.Participant{}, err
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
