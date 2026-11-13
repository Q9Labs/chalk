package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r RecordingLifecycleRepository) publish(ctx context.Context, authority recordinglifecycle.Authority, requestKey, operationName string, occurredAt time.Time, noPublisher bool) (recordinglifecycle.Publication, error) {
	if r.transactor == nil {
		return recordinglifecycle.Publication{}, recordinglifecycle.ErrRepositoryUnavailable
	}
	// PostgreSQL timestamptz stores microseconds. Canonicalize before both the
	// idempotency fingerprint and durable capture-ready source are produced so
	// a nanosecond-precision retry compares against the value the database can
	// actually preserve.
	occurredAt = occurredAt.UTC().Truncate(time.Microsecond)
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
	publication := lifecyclePublish{
		repo: r, tx: transaction, queries: sqlc.New(transaction), authority: authority, ids: ids,
		requestKey: requestKey, operationName: operationName, occurredAt: occurredAt, noPublisher: noPublisher,
	}
	return publication.execute(ctx)
}

// lifecyclePublish is one capture lifecycle publication inside its transaction.
type lifecyclePublish struct {
	repo          RecordingLifecycleRepository
	tx            pgx.Tx
	queries       *sqlc.Queries
	authority     recordinglifecycle.Authority
	ids           lifecycleIDSet
	requestKey    string
	operationName string
	occurredAt    time.Time
	noPublisher   bool
}

func (p lifecyclePublish) execute(ctx context.Context) (recordinglifecycle.Publication, error) {
	row, err := p.lockAuthority(ctx)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	deadlineStop, err := p.classifyStop(ctx, row)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	// Episode end already publishes the stopped state in Sync. A fresh capture
	// authority may acknowledge that state without creating another operation.
	if p.operationName == recordingCaptureStoppedOperation && row.EpisodeStopApplied {
		return recordinglifecycle.Publication{}, p.commit(ctx, "commit episode stop acknowledgment")
	}
	// A deadline or explicit stop may advance after a lost response. Replay the
	// committed observation before choosing a stop authority for a new one.
	publication, replayed, err := p.replayCommitted(ctx)
	if err != nil || replayed {
		return publication, err
	}
	payload, err := p.operationPayload(row, deadlineStop)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	if !lifecycleStatusAllowsNewOperation(row.RecordingStatus, p.operationName) && !(deadlineStop && (row.RecordingStatus == "starting" || row.RecordingStatus == "recording")) {
		return recordinglifecycle.Publication{}, fmt.Errorf("recording status %q rejects %s: %w", row.RecordingStatus, p.operationName, recordinglifecycle.ErrAuthorityMismatch)
	}
	webhookMetric, err := p.markCaptureReady(ctx, row)
	if err != nil {
		return recordinglifecycle.Publication{}, err
	}
	publication, replayed, err = p.insertOperation(ctx, payload)
	if err != nil || replayed {
		return publication, err
	}
	if err := p.commit(ctx, "commit transaction"); err != nil {
		return recordinglifecycle.Publication{}, err
	}
	webhookMetric.Record(ctx)
	return publication, nil
}

func (p lifecyclePublish) commit(ctx context.Context, label string) error {
	if err := p.tx.Commit(ctx); err != nil {
		return recordingLifecycleRepositoryError(label, err)
	}
	return nil
}

func (p lifecyclePublish) replayCommitted(ctx context.Context) (recordinglifecycle.Publication, bool, error) {
	publication, replayed, err := p.repo.replay(ctx, p.queries, p.ids, p.operationName, p.requestKey, p.authority.CaptureEpoch, p.occurredAt, p.noPublisher)
	if err != nil || !replayed {
		return recordinglifecycle.Publication{}, false, err
	}
	if p.operationName == recordingCaptureReadyOperation {
		if err := validateRecordingPresentationSourceReplay(ctx, p.queries, p.ids, p.authority.CaptureEpoch, p.occurredAt); err != nil {
			return recordinglifecycle.Publication{}, false, err
		}
	}
	if err := p.commit(ctx, "commit replay"); err != nil {
		return recordinglifecycle.Publication{}, false, err
	}
	return publication, true, nil
}

// lockAuthority takes the Sync control row before anything of the Episode's: the operation insert needs
// it again through its foreign key, so it comes first rather than after the recording rows.
func (p lifecyclePublish) lockAuthority(ctx context.Context) (sqlc.LockRecordingCaptureLifecycleAuthorityRow, error) {
	ids, authority := p.ids, p.authority
	if _, err := p.queries.LockSyncEpisodeControlForUpdate(ctx, sqlc.LockSyncEpisodeControlForUpdateParams{TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID}); errors.Is(err, pgx.ErrNoRows) {
		return sqlc.LockRecordingCaptureLifecycleAuthorityRow{}, fmt.Errorf("lock live capture authority: %w", recordinglifecycle.ErrAuthorityMismatch)
	} else if err != nil {
		return sqlc.LockRecordingCaptureLifecycleAuthorityRow{}, recordingLifecycleRepositoryError("lock episode control", err)
	}
	row, err := p.queries.LockRecordingCaptureLifecycleAuthority(ctx, sqlc.LockRecordingCaptureLifecycleAuthorityParams{
		JobID: ids.jobID, AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration,
		CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest, LeaseToken: authority.LeaseToken,
		LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: timestamptz(&authority.LeaseExpiresAt), TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID, RecordingID: ids.recordingID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, fmt.Errorf("lock live capture authority: %w", recordinglifecycle.ErrAuthorityMismatch)
	}
	if err != nil {
		return row, recordingLifecycleRepositoryError("lock authority", err)
	}
	return row, nil
}

// classifyStop refuses a stop that arrives before its authority and records the duration limit when
// the sealed deadline ended the capture. Worker timers and API wall time may differ slightly: a
// callback exactly at the sealed deadline can retry, but must not authorize an early stop.
func (p lifecyclePublish) classifyStop(ctx context.Context, row sqlc.LockRecordingCaptureLifecycleAuthorityRow) (deadlineStop bool, err error) {
	if p.operationName != recordingCaptureStoppedOperation {
		return false, nil
	}
	deadline := timestamp(row.CaptureDeadline)
	if !row.CaptureDeadlineReached && p.occurredAt.Equal(deadline) {
		return false, recordinglifecycle.ErrDeadlineStopPending
	}
	if row.EpisodeStopPending {
		return false, recordinglifecycle.ErrEpisodeStopPending
	}
	if !row.CaptureDeadlineReached || p.occurredAt.Before(deadline) {
		return false, nil
	}
	if err := p.queries.SetRecordingCaptureDurationLimit(ctx, sqlc.SetRecordingCaptureDurationLimitParams{JobID: p.ids.jobID, TenantID: p.ids.tenantID}); err != nil {
		return false, recordingLifecycleRepositoryError("record capture duration limit", err)
	}
	return true, nil
}

type lifecycleOperationPayload struct {
	bytes       []byte
	fingerprint [sha256.Size]byte
}

func (p lifecyclePublish) operationPayload(row sqlc.LockRecordingCaptureLifecycleAuthorityRow, deadlineStop bool) (lifecycleOperationPayload, error) {
	var payload []byte
	var err error
	if deadlineStop {
		payload, err = json.Marshal(deadlineStoppedPayload{RecordingID: p.authority.RecordingID, DeadlineAtMillis: timestamp(row.CaptureDeadline).UnixMilli(), CaptureEpoch: p.authority.CaptureEpoch})
	} else {
		operationID, operationErr := lifecycleOperationID(row, p.operationName)
		if operationErr != nil {
			return lifecycleOperationPayload{}, operationErr
		}
		payload, err = lifecyclePayload(p.operationName, p.authority.RecordingID, operationID, p.authority.CaptureEpoch)
	}
	if err != nil {
		return lifecycleOperationPayload{}, err
	}
	return lifecycleOperationPayload{bytes: payload, fingerprint: lifecycleRequestFingerprint(payload, p.occurredAt, p.noPublisher)}, nil
}

// markCaptureReady stores the capture-ready origin, freezes the presentation source and queues the
// started webhook. Every other operation has nothing to do here.
func (p lifecyclePublish) markCaptureReady(ctx context.Context, row sqlc.LockRecordingCaptureLifecycleAuthorityRow) (webhookCommitMetric, error) {
	if p.operationName != recordingCaptureReadyOperation {
		return webhookCommitMetric{}, nil
	}
	ids, epoch := p.ids, p.authority.CaptureEpoch
	if row.CaptureReadyAt.Valid && !row.CaptureReadyAt.Time.Equal(p.occurredAt) {
		return webhookCommitMetric{}, recordinglifecycle.ErrOperationConflict
	}
	if _, err := p.queries.SetRecordingCaptureReadyAt(ctx, sqlc.SetRecordingCaptureReadyAtParams{
		CaptureReadyAt: timestamptzValue(p.occurredAt), RecordingID: ids.recordingID,
		TenantID: ids.tenantID, CaptureEpoch: epoch,
	}); errors.Is(err, pgx.ErrNoRows) {
		return webhookCommitMetric{}, fmt.Errorf("set capture-ready origin: %w", recordinglifecycle.ErrAuthorityMismatch)
	} else if err != nil {
		return webhookCommitMetric{}, recordingLifecycleRepositoryError("set capture ready origin", err)
	}
	if err := freezeRecordingPresentationSource(ctx, p.queries, ids, epoch, p.occurredAt); err != nil {
		return webhookCommitMetric{}, err
	}
	return produceRecordingWebhook(ctx, p.tx, id(ids.tenantID), id(ids.recordingID), "started", p.occurredAt, "")
}

// insertOperation writes the operation row. When a concurrent request already wrote it, the stored
// publication is returned with replayed set.
func (p lifecyclePublish) insertOperation(ctx context.Context, payload lifecycleOperationPayload) (publication recordinglifecycle.Publication, replayed bool, err error) {
	ids := p.ids
	journey, err := recordingLifecycleJourneyFromContext(ctx)
	if err != nil {
		return publication, false, err
	}
	traceID, spanID, traceparent, tracestate := lifecycleTraceContext(ctx)
	externalOperationID, err := utilities.NewID()
	if err != nil {
		return publication, false, fmt.Errorf("generate recording capture lifecycle operation id: %w", err)
	}
	inserted, err := p.queries.InsertRecordingCaptureLifecycleOperation(ctx, sqlc.InsertRecordingCaptureLifecycleOperationParams{
		TenantID: ids.tenantID, SpaceID: ids.spaceID, EpisodeID: ids.episodeID, ExternalOperationID: uuid(externalOperationID),
		RequestKey: p.requestKey, RequestFingerprint: payload.fingerprint[:], OperationName: p.operationName, RecordingID: ids.recordingID,
		JourneyID: uuid(journey.ID), ParentJourneyEventID: uuid(journey.ParentEventID), ProducingTraceID: optionalText(traceID), ProducingSpanID: optionalText(spanID), ProducingTraceparent: optionalText(traceparent), ProducingTracestate: optionalText(tracestate), Payload: payload.bytes,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return p.replayLostInsert(ctx)
	}
	if err != nil {
		return publication, false, recordingLifecycleRepositoryError("insert operation", err)
	}
	if err := persistRecordingLifecycleJourneyRoot(ctx, p.tx, journey, p.operationName, p.authority.AttemptCount, p.occurredAt, p.noPublisher); err != nil {
		return publication, false, err
	}
	publication, err = mapRecordingLifecyclePublication(inserted)
	return publication, false, err
}

func (p lifecyclePublish) replayLostInsert(ctx context.Context) (recordinglifecycle.Publication, bool, error) {
	publication, found, err := p.repo.replay(ctx, p.queries, p.ids, p.operationName, p.requestKey, p.authority.CaptureEpoch, p.occurredAt, p.noPublisher)
	if err != nil {
		return recordinglifecycle.Publication{}, false, err
	}
	if !found {
		return recordinglifecycle.Publication{}, false, recordinglifecycle.ErrOperationConflict
	}
	if err := p.commit(ctx, "commit replay"); err != nil {
		return recordinglifecycle.Publication{}, false, err
	}
	return publication, true, nil
}
