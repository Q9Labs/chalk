package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

const (
	recordingCaptureReadyOperation   = "recording_capture_ready"
	recordingCaptureStoppedOperation = "recording_capture_stopped"
)

type recordingLifecycleTransactor interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type recordingLifecycleQuerier interface {
	LockRecordingCaptureLifecycleAuthority(context.Context, sqlc.LockRecordingCaptureLifecycleAuthorityParams) (sqlc.LockRecordingCaptureLifecycleAuthorityRow, error)
	LockRecordingCaptureLifecycleOperation(context.Context, sqlc.LockRecordingCaptureLifecycleOperationParams) (sqlc.SyncExternalOperation, error)
	InsertRecordingCaptureLifecycleOperation(context.Context, sqlc.InsertRecordingCaptureLifecycleOperationParams) (sqlc.SyncExternalOperation, error)
}

type RecordingLifecycleRepository struct {
	transactor recordingLifecycleTransactor
}

func NewRecordingLifecycleRepository(pool *pgxpool.Pool) RecordingLifecycleRepository {
	return NewRecordingLifecycleRepositoryWithPool(pool)
}

func NewRecordingLifecycleRepositoryWithPool(pool *pgxpool.Pool) RecordingLifecycleRepository {
	return RecordingLifecycleRepository{transactor: pool}
}

func NewRecordingLifecycleRepositoryWithTransactor(transactor recordingLifecycleTransactor) RecordingLifecycleRepository {
	return RecordingLifecycleRepository{transactor: transactor}
}

func (r RecordingLifecycleRepository) PublishReady(ctx context.Context, input recordinglifecycle.ReadyInput) (recordinglifecycle.Publication, error) {
	return r.publish(ctx, input.Authority, input.RequestKey, recordingCaptureReadyOperation, input.ReadyAt, input.NoPublisher)
}

func (r RecordingLifecycleRepository) PublishStopped(ctx context.Context, input recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error) {
	return r.publish(ctx, input.Authority, input.RequestKey, recordingCaptureStoppedOperation, input.StoppedAt, false)
}

func (r RecordingLifecycleRepository) publish(ctx context.Context, authority recordinglifecycle.Authority, requestKey, operationName string, occurredAt time.Time, noPublisher bool) (recordinglifecycle.Publication, error) {
	if r.transactor == nil {
		return recordinglifecycle.Publication{}, recordinglifecycle.ErrRepositoryUnavailable
	}
	ids, err := lifecycleIDs(authority)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	transaction, err := r.transactor.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return recordinglifecycle.Publication{}, recordingLifecycleRepositoryError("begin transaction", err)
	}
	defer transaction.Rollback(ctx)
	if _, err := transaction.Exec(ctx, `select
		set_config('synchronous_commit', 'on', true),
		set_config('lock_timeout', '750ms', true),
		set_config('statement_timeout', '2s', true),
		set_config('transaction_timeout', '3s', true)`); err != nil {
		return recordinglifecycle.Publication{}, recordingLifecycleRepositoryError("set transaction bounds", err)
	}
	queries := sqlc.New(transaction)
	authorityRow, err := queries.LockRecordingCaptureLifecycleAuthority(ctx, sqlc.LockRecordingCaptureLifecycleAuthorityParams{
		JobID: ids.jobID, AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration,
		CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest, LeaseToken: authority.LeaseToken,
		LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: timestamptz(&authority.LeaseExpiresAt), TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID, RecordingID: ids.recordingID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordinglifecycle.Publication{}, recordinglifecycle.ErrAuthorityMismatch
	}
	if err != nil {
		return recordinglifecycle.Publication{}, recordingLifecycleRepositoryError("lock authority", err)
	}
	operationID, err := lifecycleOperationID(authorityRow, operationName)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	payload, err := lifecyclePayload(operationName, authority.RecordingID, operationID, authority.CaptureEpoch)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	fingerprint := sha256.Sum256(payload)
	publication, replayed, err := r.replay(ctx, queries, ids, operationName, requestKey, fingerprint[:])
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	if replayed {
		if err := transaction.Commit(ctx); err != nil {
			return recordinglifecycle.Publication{}, recordingLifecycleRepositoryError("commit replay", err)
		}
		return publication, nil
	}
	if !lifecycleStatusAllowsNewOperation(authorityRow.RecordingStatus, operationName) {
		return recordinglifecycle.Publication{}, recordinglifecycle.ErrAuthorityMismatch
	}
	journey, err := recordingLifecycleJourneyFromContext(ctx)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	traceID, spanID, traceparent, tracestate := lifecycleTraceContext(ctx)
	externalOperationID, err := utilities.NewID()
	if err != nil {
		return recordinglifecycle.Publication{}, fmt.Errorf("generate recording capture lifecycle operation id: %w", err)
	}
	inserted, err := queries.InsertRecordingCaptureLifecycleOperation(ctx, sqlc.InsertRecordingCaptureLifecycleOperationParams{
		TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID, ExternalOperationID: uuid(externalOperationID),
		RequestKey: requestKey, RequestFingerprint: fingerprint[:], OperationName: operationName, RecordingID: ids.recordingID,
		JourneyID: uuid(journey.ID), ParentJourneyEventID: uuid(journey.ParentEventID), ProducingTraceID: optionalText(traceID), ProducingSpanID: optionalText(spanID), ProducingTraceparent: optionalText(traceparent), ProducingTracestate: optionalText(tracestate), Payload: payload,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		publication, found, replayErr := r.replay(ctx, queries, ids, operationName, requestKey, fingerprint[:])
		if replayErr != nil {
			return recordinglifecycle.Publication{}, replayErr
		}
		if !found {
			return recordinglifecycle.Publication{}, recordinglifecycle.ErrOperationConflict
		}
		if err := transaction.Commit(ctx); err != nil {
			return recordinglifecycle.Publication{}, recordingLifecycleRepositoryError("commit replay", err)
		}
		return publication, nil
	}
	if err != nil {
		return recordinglifecycle.Publication{}, recordingLifecycleRepositoryError("insert operation", err)
	}
	if err := persistRecordingLifecycleJourneyRoot(ctx, transaction, journey, operationName, authority.AttemptCount, occurredAt, noPublisher); err != nil {
		return recordinglifecycle.Publication{}, err
	}
	publication, err = mapRecordingLifecyclePublication(inserted)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return recordinglifecycle.Publication{}, recordingLifecycleRepositoryError("commit transaction", err)
	}
	return publication, nil
}

type lifecycleIDSet struct {
	tenantID    pgtype.UUID
	spaceID     pgtype.UUID
	episodeID   pgtype.UUID
	recordingID pgtype.UUID
	jobID       pgtype.UUID
}

func lifecycleIDs(authority recordinglifecycle.Authority) (lifecycleIDSet, error) {
	values := []struct {
		name  string
		value string
		set   *pgtype.UUID
	}{
		{name: "tenant_id", value: authority.TenantID, set: new(pgtype.UUID)},
		{name: "space_id", value: authority.SpaceID, set: new(pgtype.UUID)},
		{name: "episode_id", value: authority.EpisodeID, set: new(pgtype.UUID)},
		{name: "recording_id", value: authority.RecordingID, set: new(pgtype.UUID)},
		{name: "job_id", value: authority.JobID, set: new(pgtype.UUID)},
	}
	for _, item := range values {
		parsed, err := utilities.ParseID(item.value)
		if err != nil {
			return lifecycleIDSet{}, fmt.Errorf("%w: %s", recordinglifecycle.ErrInvalidRequest, item.name)
		}
		*item.set = uuid(parsed)
	}
	return lifecycleIDSet{tenantID: *values[0].set, spaceID: *values[1].set, episodeID: *values[2].set, recordingID: *values[3].set, jobID: *values[4].set}, nil
}

func lifecycleOperationID(row sqlc.LockRecordingCaptureLifecycleAuthorityRow, operationName string) (string, error) {
	if operationName == recordingCaptureReadyOperation {
		if !row.StartExternalOperationID.Valid {
			return "", recordinglifecycle.ErrAuthorityMismatch
		}
		return utilities.IDFromBytes(row.StartExternalOperationID.Bytes).String(), nil
	}
	if !row.StopExternalOperationID.Valid {
		return "", recordinglifecycle.ErrAuthorityMismatch
	}
	return utilities.IDFromBytes(row.StopExternalOperationID.Bytes).String(), nil
}

func lifecycleStatusAllowsNewOperation(recordingStatus, operationName string) bool {
	if operationName == recordingCaptureReadyOperation {
		return recordingStatus == "starting"
	}
	return recordingStatus == "stopping"
}

type readyPayload struct {
	RecordingID      string `json:"recordingId"`
	StartOperationID string `json:"startOperationId"`
	CaptureEpoch     int64  `json:"captureEpoch"`
}

type stoppedPayload struct {
	RecordingID     string `json:"recordingId"`
	StopOperationID string `json:"stopOperationId"`
	CaptureEpoch    int64  `json:"captureEpoch"`
}

func lifecyclePayload(operationName, recordingID, operationID string, captureEpoch int64) ([]byte, error) {
	var payload any
	if operationName == recordingCaptureReadyOperation {
		payload = readyPayload{RecordingID: recordingID, StartOperationID: operationID, CaptureEpoch: captureEpoch}
	} else {
		payload = stoppedPayload{RecordingID: recordingID, StopOperationID: operationID, CaptureEpoch: captureEpoch}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal recording capture lifecycle payload: %w", err)
	}
	return encoded, nil
}

func (r RecordingLifecycleRepository) replay(ctx context.Context, queries recordingLifecycleQuerier, ids lifecycleIDSet, operationName, requestKey string, fingerprint []byte) (recordinglifecycle.Publication, bool, error) {
	operation, err := queries.LockRecordingCaptureLifecycleOperation(ctx, sqlc.LockRecordingCaptureLifecycleOperationParams{TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID, OperationName: operationName, RequestKey: requestKey})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordinglifecycle.Publication{}, false, nil
	}
	if err != nil {
		return recordinglifecycle.Publication{}, false, recordingLifecycleRepositoryError("lock replay operation", err)
	}
	if !bytes.Equal(operation.RequestFingerprint, fingerprint) || !operation.RecordingID.Valid || operation.RecordingID != ids.recordingID {
		return recordinglifecycle.Publication{}, false, recordinglifecycle.ErrOperationConflict
	}
	publication, err := mapRecordingLifecyclePublication(operation)
	return publication, err == nil, err
}

func mapRecordingLifecyclePublication(operation sqlc.SyncExternalOperation) (recordinglifecycle.Publication, error) {
	if !operation.ExternalOperationID.Valid {
		return recordinglifecycle.Publication{}, recordinglifecycle.ErrOperationConflict
	}
	return recordinglifecycle.Publication{
		ExternalOperationID: utilities.IDFromBytes(operation.ExternalOperationID.Bytes).String(),
		OperationName:       operation.OperationName,
		RequestKey:          operation.RequestKey,
		RequestFingerprint:  append([]byte(nil), operation.RequestFingerprint...),
		Payload:             append([]byte(nil), operation.Payload...),
	}, nil
}

func recordingLifecycleRepositoryError(operation string, err error) error {
	return fmt.Errorf("%w: %s: %w", recordinglifecycle.ErrRepositoryUnavailable, operation, err)
}

type recordingLifecycleJourney struct {
	ID            utilities.ID
	ParentEventID utilities.ID
}

func recordingLifecycleJourneyFromContext(ctx context.Context) (recordingLifecycleJourney, error) {
	if journeyID, ok := observability.JourneyIDFromContext(ctx); ok {
		parentEventID, err := utilities.NewID()
		if err != nil {
			return recordingLifecycleJourney{}, fmt.Errorf("generate recording capture lifecycle journey event id: %w", err)
		}
		return recordingLifecycleJourney{ID: journeyID, ParentEventID: parentEventID}, nil
	}
	journeyID, err := utilities.NewID()
	if err != nil {
		return recordingLifecycleJourney{}, fmt.Errorf("generate recording capture lifecycle journey id: %w", err)
	}
	parentEventID, err := utilities.NewID()
	if err != nil {
		return recordingLifecycleJourney{}, fmt.Errorf("generate recording capture lifecycle journey event id: %w", err)
	}
	return recordingLifecycleJourney{ID: journeyID, ParentEventID: parentEventID}, nil
}

type recordingLifecycleJourneyAttributes struct {
	OperationName  string    `json:"operation_name"`
	CaptureAttempt int       `json:"capture_attempt"`
	ObservedAt     time.Time `json:"observed_at"`
	NoPublisher    *bool     `json:"no_publisher,omitempty"`
}

func persistRecordingLifecycleJourneyRoot(ctx context.Context, transaction pgx.Tx, journey recordingLifecycleJourney, operationName string, attempt int, observedAt time.Time, noPublisher bool) error {
	attributes := recordingLifecycleJourneyAttributes{OperationName: operationName, CaptureAttempt: attempt, ObservedAt: observedAt.UTC()}
	if operationName == recordingCaptureReadyOperation {
		attributes.NoPublisher = &noPublisher
	}
	encoded, err := json.Marshal(attributes)
	if err != nil {
		return fmt.Errorf("marshal recording capture lifecycle journey attributes: %w", err)
	}
	traceID, spanID, _, _ := lifecycleTraceContext(ctx)
	_, err = transaction.Exec(ctx, `insert into observability_journey_events(event_id, journey_id, sequence, occurred_at, name, phase, state, origin_kind, first_observed_layer, upstream_visibility, trace_id, span_id, attributes) values($1, $2, 0, now(), $3, 'capture_callback', 'accepted', 'worker', 'api', 'visible', $4, $5, $6)`, uuid(journey.ParentEventID), uuid(journey.ID), operationName, optionalText(traceID), optionalText(spanID), encoded)
	if err != nil {
		return recordingLifecycleRepositoryError("persist journey root", err)
	}
	return nil
}

func lifecycleTraceContext(ctx context.Context) (string, string, string, string) {
	span := trace.SpanContextFromContext(ctx)
	if !span.IsValid() {
		return "", "", "", ""
	}
	traceID, spanID := span.TraceID().String(), span.SpanID().String()
	traceparent := fmt.Sprintf("00-%s-%s-%02x", traceID, spanID, byte(span.TraceFlags()))
	return traceID, spanID, traceparent, span.TraceState().String()
}
