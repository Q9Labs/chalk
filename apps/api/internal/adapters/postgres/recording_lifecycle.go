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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
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
	SetRecordingCaptureReadyAt(context.Context, sqlc.SetRecordingCaptureReadyAtParams) (pgtype.Timestamptz, error)
	InsertRecordingPresentationSource(context.Context, sqlc.InsertRecordingPresentationSourceParams) (sqlc.RecordingPresentationSource, error)
	GetRecordingPresentationSource(context.Context, sqlc.GetRecordingPresentationSourceParams) (sqlc.GetRecordingPresentationSourceRow, error)
}

type RecordingLifecycleRepository struct {
	transactor recordingLifecycleTransactor
}

func NewRecordingLifecycleRepository(pool *pgxpool.Pool) RecordingLifecycleRepository {
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

func (r RecordingLifecycleRepository) replay(ctx context.Context, queries recordingLifecycleQuerier, ids lifecycleIDSet, operationName, requestKey string, captureEpoch int64, occurredAt time.Time, noPublisher bool) (recordinglifecycle.Publication, bool, error) {
	operation, err := queries.LockRecordingCaptureLifecycleOperation(ctx, sqlc.LockRecordingCaptureLifecycleOperationParams{TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID, OperationName: operationName, RequestKey: requestKey})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordinglifecycle.Publication{}, false, nil
	}
	if err != nil {
		return recordinglifecycle.Publication{}, false, recordingLifecycleRepositoryError("lock replay operation", err)
	}
	var payload struct {
		RecordingID      string `json:"recordingId"`
		StartOperationID string `json:"startOperationId,omitempty"`
		StopOperationID  string `json:"stopOperationId,omitempty"`
		DeadlineAtMillis int64  `json:"deadlineAtMs,omitempty"`
		CaptureEpoch     int64  `json:"captureEpoch"`
	}
	if err := json.Unmarshal(operation.Payload, &payload); err != nil || payload.CaptureEpoch != captureEpoch || payload.RecordingID != utilities.IDFromBytes(ids.recordingID.Bytes).String() {
		return recordinglifecycle.Publication{}, false, recordinglifecycle.ErrOperationConflict
	}
	// jsonb reorders keys; retain the original typed payload order used by
	// previously committed ready and explicit-stop request fingerprints.
	canonicalPayload, err := json.Marshal(payload)
	if err != nil {
		return recordinglifecycle.Publication{}, false, recordinglifecycle.ErrOperationConflict
	}
	fingerprint := lifecycleRequestFingerprint(canonicalPayload, occurredAt, noPublisher)
	if !bytes.Equal(operation.RequestFingerprint, fingerprint[:]) || !operation.RecordingID.Valid || operation.RecordingID != ids.recordingID {
		return recordinglifecycle.Publication{}, false, recordinglifecycle.ErrOperationConflict
	}
	publication, err := mapRecordingLifecyclePublication(operation)
	return publication, err == nil, err
}

func recordingLifecycleRepositoryError(operation string, err error) error {
	return fmt.Errorf("%w: %s: %w", recordinglifecycle.ErrRepositoryUnavailable, operation, err)
}
