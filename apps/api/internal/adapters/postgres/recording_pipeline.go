package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingPipelineQuerier interface {
	ClaimRecordingJob(context.Context, sqlc.ClaimRecordingJobParams) (sqlc.ClaimRecordingJobRow, error)
	CommitRecordingArtifact(context.Context, sqlc.CommitRecordingArtifactParams) (sqlc.CommitRecordingArtifactRow, error)
	CompleteCaptureRecordingJob(context.Context, sqlc.CompleteCaptureRecordingJobParams) (sqlc.RecordingJob, error)
	CompleteRecordingJob(context.Context, sqlc.CompleteRecordingJobParams) (sqlc.RecordingJob, error)
	CreateRecordingReservation(context.Context, sqlc.CreateRecordingReservationParams) (sqlc.CreateRecordingReservationRow, error)
	GetRecordingArtifact(context.Context, sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error)
	GetRecordingReservationFingerprint(context.Context, sqlc.GetRecordingReservationFingerprintParams) ([]byte, error)
	GetRecordingReservationByKey(context.Context, sqlc.GetRecordingReservationByKeyParams) (sqlc.GetRecordingReservationByKeyRow, error)
	ExtendRecordingReservation(context.Context, sqlc.ExtendRecordingReservationParams) (sqlc.ExtendRecordingReservationRow, error)
	FailRecordingJob(context.Context, sqlc.FailRecordingJobParams) (sqlc.FailRecordingJobRow, error)
	GetRecordingPipeline(context.Context, sqlc.GetRecordingPipelineParams) (sqlc.RecordingPipeline, error)
	GetRecordingReservation(context.Context, sqlc.GetRecordingReservationParams) (sqlc.GetRecordingReservationRow, error)
	HeartbeatRecordingJob(context.Context, sqlc.HeartbeatRecordingJobParams) (sqlc.RecordingJob, error)
	InsertRecordingBundle(context.Context, sqlc.InsertRecordingBundleParams) (sqlc.RecordingBundle, error)
	ListRecordingDeadLetters(context.Context, sqlc.ListRecordingDeadLettersParams) ([]sqlc.RecordingJob, error)
	ListRecordingJobsForReconciliation(context.Context, sqlc.ListRecordingJobsForReconciliationParams) ([]sqlc.RecordingJob, error)
	ExpireRecordingReservations(context.Context, pgtype.Timestamptz) ([]sqlc.ExpireRecordingReservationsRow, error)
	RecoverExpiredRecordingJobs(context.Context) ([]sqlc.RecoverExpiredRecordingJobsRow, error)
	ReleaseRecordingReservation(context.Context, sqlc.ReleaseRecordingReservationParams) (sqlc.ReleaseRecordingReservationRow, error)
	UpsertRecordingPoolHealth(context.Context, sqlc.UpsertRecordingPoolHealthParams) (sqlc.RecordingPoolHealth, error)
	GetRecordingPoolHealth(context.Context, string) (sqlc.RecordingPoolHealth, error)
}

type recordingPipelineTransactor interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type RecordingPipelineRepository struct {
	queries    recordingPipelineQuerier
	transactor recordingPipelineTransactor
	decorate   func(sqlc.Querier) sqlc.Querier
	now        func() time.Time
}

func NewRecordingPipelineRepository(queries recordingPipelineQuerier) RecordingPipelineRepository {
	return RecordingPipelineRepository{queries: queries, now: time.Now}
}

func NewRecordingPipelineRepositoryWithTransactor(transactor recordingPipelineTransactor) RecordingPipelineRepository {
	return RecordingPipelineRepository{transactor: transactor, now: time.Now}
}

func NewRecordingPipelineRepositoryWithQueriesAndTransactor(queries recordingPipelineQuerier, transactor recordingPipelineTransactor, decorate func(sqlc.Querier) sqlc.Querier) RecordingPipelineRepository {
	return RecordingPipelineRepository{queries: queries, transactor: transactor, decorate: decorate, now: time.Now}
}

func NewRecordingPipelineRepositoryWithPool(pool *pgxpool.Pool) RecordingPipelineRepository {
	return RecordingPipelineRepository{queries: sqlc.New(pool), transactor: pool, now: time.Now}
}

func (r RecordingPipelineRepository) Reserve(ctx context.Context, input recordingpipeline.ReservationInput, captureJobID utilities.ID) (recordingpipeline.Reservation, error) {
	if err := recordingpipeline.ValidateReservationInput(input); err != nil {
		return recordingpipeline.Reservation{}, err
	}
	if captureJobID.IsZero() {
		return recordingpipeline.Reservation{}, recordingpipeline.ErrInvalidJobID
	}
	if input.ID.IsZero() {
		var err error
		input.ID, err = utilities.NewID()
		if err != nil {
			return recordingpipeline.Reservation{}, err
		}
	}
	if input.RecordingID.IsZero() {
		var err error
		input.RecordingID, err = utilities.NewID()
		if err != nil {
			return recordingpipeline.Reservation{}, err
		}
	}
	fingerprint := recordingpipeline.ReservationFingerprint(input)
	if existing, err := r.queries.GetRecordingReservationFingerprint(ctx, sqlc.GetRecordingReservationFingerprintParams{
		TenantID: uuid(input.TenantID), IdempotencyKey: input.IdempotencyKey,
	}); err == nil {
		if !bytes.Equal(existing, fingerprint[:]) {
			return recordingpipeline.Reservation{}, recordingpipeline.ErrReservationConflict
		}
		row, getErr := r.queries.GetRecordingReservation(ctx, sqlc.GetRecordingReservationParams{
			TenantID: uuid(input.TenantID), ID: uuid(input.ID),
		})
		if getErr == nil {
			return mapGetReservation(row), nil
		}
		// The key is authoritative; the request may have supplied a fresh ID.
		rowByKey, keyErr := r.queries.GetRecordingReservationByKey(ctx, sqlc.GetRecordingReservationByKeyParams{
			TenantID: uuid(input.TenantID), IdempotencyKey: input.IdempotencyKey, RequestFingerprint: fingerprint[:],
		})
		if keyErr == nil {
			return mapReservationByKey(rowByKey), nil
		}
		return recordingpipeline.Reservation{}, fmt.Errorf("get idempotent recording reservation: %w", getErr)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Reservation{}, fmt.Errorf("check recording reservation idempotency: %w", err)
	}
	start := r.now().UTC()
	if input.StartsAt != nil {
		start = input.StartsAt.UTC()
	}
	availableAt := start
	if input.StartsAt != nil {
		availableAt = start.Add(-recordingpipeline.CapturePrewarm)
	} else {
		availableAt = time.Unix(0, 0).UTC()
	}
	params := sqlc.CreateRecordingReservationParams{
		ParticipantMeetings:  1,
		ParticipantCount:     int32(input.ParticipantCount),
		InputBitrateBps:      input.InputBitrateBPS,
		ID:                   uuid(input.ID),
		TenantID:             uuid(input.TenantID),
		RoomID:               uuid(input.RoomID),
		SessionID:            uuid(input.SessionID),
		RecordingID:          uuid(input.RecordingID),
		IdempotencyKey:       input.IdempotencyKey,
		RequestFingerprint:   fingerprint[:],
		MaxDurationSeconds:   int32(input.MaxDuration / time.Second),
		StartsAt:             timestamptz(input.StartsAt),
		EndsAt:               timestamptzValue(start.Add(input.MaxDuration)),
		CaptureJobID:         uuid(captureJobID),
		PayloadSchemaVersion: recordingpipeline.DefaultPayloadSchemaVersion,
		Priority:             0,
		AvailableAt:          timestamptzValue(availableAt),
		AttemptLimit:         recordingpipeline.DefaultCaptureAttemptLimit,
	}
	var row sqlc.CreateRecordingReservationRow
	var err error
	if r.transactor == nil {
		if r.queries == nil {
			return recordingpipeline.Reservation{}, errors.New("recording pipeline repository has no query executor")
		}
		row, err = r.queries.CreateRecordingReservation(ctx, params)
	} else {
		err = r.transaction(ctx, func(queries recordingPipelineQuerier) error {
			row, err = queries.CreateRecordingReservation(ctx, params)
			return err
		})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Reservation{}, recordingpipeline.ErrRecordingCapacityUnavailable
	}
	if err != nil {
		if uniqueConstraintViolation(err, "recording_reservations_tenant_id_idempotency_key_key") {
			return r.reserveReplay(ctx, input, fingerprint)
		}
		return recordingpipeline.Reservation{}, fmt.Errorf("reserve recording capacity: %w", err)
	}
	return mapReservation(row), nil
}

func (r RecordingPipelineRepository) GetReservation(ctx context.Context, tenantID, reservationID utilities.ID) (recordingpipeline.Reservation, error) {
	row, err := r.queries.GetRecordingReservation(ctx, sqlc.GetRecordingReservationParams{TenantID: uuid(tenantID), ID: uuid(reservationID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Reservation{}, recordingpipeline.ErrReservationNotFound
	}
	if err != nil {
		return recordingpipeline.Reservation{}, fmt.Errorf("get recording reservation: %w", err)
	}
	return mapGetReservation(row), nil
}

func (r RecordingPipelineRepository) reserveReplay(ctx context.Context, input recordingpipeline.ReservationInput, fingerprint [32]byte) (recordingpipeline.Reservation, error) {
	row, err := r.queries.GetRecordingReservationByKey(ctx, sqlc.GetRecordingReservationByKeyParams{
		TenantID: uuid(input.TenantID), IdempotencyKey: input.IdempotencyKey, RequestFingerprint: fingerprint[:],
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Reservation{}, recordingpipeline.ErrReservationConflict
	}
	if err != nil {
		return recordingpipeline.Reservation{}, fmt.Errorf("get recording reservation replay: %w", err)
	}
	return mapReservationByKey(row), nil
}

func (r RecordingPipelineRepository) ReleaseReservation(ctx context.Context, tenantID, reservationID utilities.ID, state recordingpipeline.ReservationState) (recordingpipeline.Reservation, error) {
	if state != recordingpipeline.ReservationStateReleased && state != recordingpipeline.ReservationStateExpired {
		return recordingpipeline.Reservation{}, recordingpipeline.ErrInvalidStateTransition
	}
	row, err := r.queries.ReleaseRecordingReservation(ctx, sqlc.ReleaseRecordingReservationParams{TenantID: uuid(tenantID), ID: uuid(reservationID), State: string(state)})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Reservation{}, recordingpipeline.ErrReservationNotFound
	}
	if err != nil {
		return recordingpipeline.Reservation{}, fmt.Errorf("release recording reservation: %w", err)
	}
	return mapReleasedReservation(row), nil
}

func (r RecordingPipelineRepository) ExtendReservation(ctx context.Context, tenantID, reservationID utilities.ID, duration time.Duration, endsAt time.Time) (recordingpipeline.Reservation, error) {
	_ = tenantID
	_ = reservationID
	_ = duration
	_ = endsAt
	return recordingpipeline.Reservation{}, recordingpipeline.ErrExtensionUnavailable
}

func (r RecordingPipelineRepository) ExpireReservations(ctx context.Context, now time.Time) ([]recordingpipeline.Reservation, error) {
	rows, err := r.queries.ExpireRecordingReservations(ctx, timestamptzValue(now))
	if err != nil {
		return nil, fmt.Errorf("expire recording reservations: %w", err)
	}
	reservations := make([]recordingpipeline.Reservation, 0, len(rows))
	for _, row := range rows {
		reservations = append(reservations, mapExpiredReservation(row))
	}
	return reservations, nil
}

func (r RecordingPipelineRepository) UpsertPoolHealth(ctx context.Context, health recordingpipeline.PoolHealth) (recordingpipeline.PoolHealth, error) {
	row, err := r.queries.UpsertRecordingPoolHealth(ctx, sqlc.UpsertRecordingPoolHealthParams{
		Role: string(health.Role), AdmissionOpen: health.AdmissionOpen, ReadyCapacity: int32(health.ReadyCapacity),
		Reason: health.Reason, ObservedAt: timestamptzValue(health.ObservedAt),
	})
	if err != nil {
		return recordingpipeline.PoolHealth{}, fmt.Errorf("upsert recording pool health: %w", err)
	}
	return mapPoolHealth(row), nil
}

func (r RecordingPipelineRepository) GetPoolHealth(ctx context.Context, role recordingpipeline.PoolRole) (recordingpipeline.PoolHealth, error) {
	row, err := r.queries.GetRecordingPoolHealth(ctx, string(role))
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.PoolHealth{}, recordingpipeline.ErrPoolHealthNotFound
	}
	if err != nil {
		return recordingpipeline.PoolHealth{}, fmt.Errorf("get recording pool health: %w", err)
	}
	return mapPoolHealth(row), nil
}

func (r RecordingPipelineRepository) GetPipeline(ctx context.Context, tenantID, recordingID utilities.ID) (recordingpipeline.Pipeline, error) {
	row, err := r.queries.GetRecordingPipeline(ctx, sqlc.GetRecordingPipelineParams{TenantID: uuid(tenantID), RecordingID: uuid(recordingID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Pipeline{}, recordingpipeline.ErrPipelineNotFound
	}
	if err != nil {
		return recordingpipeline.Pipeline{}, fmt.Errorf("get recording pipeline: %w", err)
	}
	return mapPipeline(row), nil
}

func (r RecordingPipelineRepository) Claim(ctx context.Context, input recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
	if input.LeaseFor <= 0 || input.LeaseToken == "" || input.Owner == "" {
		return recordingpipeline.Job{}, recordingpipeline.ErrInvalidLease
	}
	row, err := r.queries.ClaimRecordingJob(ctx, sqlc.ClaimRecordingJobParams{
		LeaseToken:     requiredTextValue(input.LeaseToken),
		LeaseOwner:     requiredTextValue(input.Owner),
		LeaseExpiresAt: timestamptzValue(r.now().UTC().Add(input.LeaseFor)),
		Kind:           string(input.Kind),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("claim recording job: %w", err)
	}
	return mapClaimJob(row), nil
}

func (r RecordingPipelineRepository) Heartbeat(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	row, err := r.queries.HeartbeatRecordingJob(ctx, sqlc.HeartbeatRecordingJobParams{
		LeaseExpiresAt:    timestamptzValue(r.now().UTC().Add(input.LeaseFor)),
		ID:                uuid(input.JobID),
		AttemptCount:      int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken),
		LeaseOwner:        requiredTextValue(input.LeaseOwner),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("heartbeat recording job: %w", err)
	}
	return mapRecordingJob(row), nil
}

func (r RecordingPipelineRepository) Complete(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	row, err := r.queries.CompleteRecordingJob(ctx, sqlc.CompleteRecordingJobParams{
		ID:                uuid(input.JobID),
		AttemptCount:      int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken),
		LeaseOwner:        requiredTextValue(input.LeaseOwner),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("complete recording job: %w", err)
	}
	return mapRecordingJob(row), nil
}

func (r RecordingPipelineRepository) CompleteCapture(ctx context.Context, input recordingpipeline.LeaseInput, renderJobID utilities.ID) (recordingpipeline.Job, error) {
	row, err := r.queries.CompleteCaptureRecordingJob(ctx, sqlc.CompleteCaptureRecordingJobParams{
		ID:                   uuid(input.JobID),
		AttemptCount:         int32(input.AttemptCount),
		FencingGeneration:    input.FencingGeneration,
		LeaseToken:           requiredTextValue(input.LeaseToken),
		LeaseOwner:           requiredTextValue(input.LeaseOwner),
		RenderJobID:          uuid(renderJobID),
		PayloadSchemaVersion: recordingpipeline.DefaultPayloadSchemaVersion,
		Priority:             0,
		AttemptLimit:         recordingpipeline.DefaultRenderAttemptLimit,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("complete capture recording job: %w", err)
	}
	return mapRecordingJob(row), nil
}

func (r RecordingPipelineRepository) Fail(ctx context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	row, err := r.queries.FailRecordingJob(ctx, sqlc.FailRecordingJobParams{
		AvailableAt:       timestamptzValue(input.AvailableAt),
		ErrorCode:         requiredTextValue(input.ErrorCode),
		ErrorDetail:       requiredTextValue(input.ErrorDetail),
		ID:                uuid(input.JobID),
		AttemptCount:      int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken),
		LeaseOwner:        requiredTextValue(input.LeaseOwner),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Job{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.Job{}, fmt.Errorf("fail recording job: %w", err)
	}
	return mapFailJob(row), nil
}

func (r RecordingPipelineRepository) RecoverExpired(ctx context.Context) ([]recordingpipeline.Job, error) {
	rows, err := r.queries.RecoverExpiredRecordingJobs(ctx)
	if err != nil {
		return nil, fmt.Errorf("recover expired recording jobs: %w", err)
	}
	jobs := make([]recordingpipeline.Job, 0, len(rows))
	for _, row := range rows {
		jobs = append(jobs, mapRecoveredJob(row))
	}
	return jobs, nil
}

func (r RecordingPipelineRepository) ListDeadLetters(ctx context.Context, tenantID utilities.ID, limit int) ([]recordingpipeline.Job, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := r.queries.ListRecordingDeadLetters(ctx, sqlc.ListRecordingDeadLettersParams{TenantID: uuid(tenantID), LimitCount: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("list recording dead letters: %w", err)
	}
	return mapJobs(rows), nil
}

func (r RecordingPipelineRepository) ListForReconciliation(ctx context.Context, query recordingpipeline.ReconciliationQuery) ([]recordingpipeline.Job, error) {
	limit := query.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := r.queries.ListRecordingJobsForReconciliation(ctx, sqlc.ListRecordingJobsForReconciliationParams{
		StaleBefore:    timestamptzValue(query.StaleBefore),
		TerminalBefore: timestamptzValue(query.TerminalBefore),
		LimitCount:     int32(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list recording jobs for reconciliation: %w", err)
	}
	return mapJobs(rows), nil
}

func (r RecordingPipelineRepository) InsertBundle(ctx context.Context, input recordingpipeline.BundleInput) (recordingpipeline.Bundle, error) {
	row, err := r.queries.InsertRecordingBundle(ctx, sqlc.InsertRecordingBundleParams{
		ID:                   uuid(input.ID),
		TenantID:             uuid(input.TenantID),
		RecordingID:          uuid(input.RecordingID),
		CaptureJobID:         uuid(input.CaptureJobID),
		SequenceNumber:       input.SequenceNumber,
		FencingGeneration:    input.FencingGeneration,
		ObjectKey:            input.ObjectKey,
		ContentType:          input.ContentType,
		Codec:                input.Codec,
		Layer:                text(input.Layer),
		ByteSize:             input.ByteSize,
		Checksum:             input.Checksum,
		MonotonicStartMillis: input.MonotonicStartMillis,
		MonotonicEndMillis:   input.MonotonicEndMillis,
		MediaStartMillis:     input.MediaStartMillis,
		MediaEndMillis:       input.MediaEndMillis,
		AttemptCount:         int32(input.AttemptCount),
		LeaseToken:           requiredTextValue(input.LeaseToken),
		LeaseOwner:           requiredTextValue(input.LeaseOwner),
	})
	if err != nil {
		return recordingpipeline.Bundle{}, fmt.Errorf("insert recording bundle: %w", err)
	}
	return mapBundle(row), nil
}

func (r RecordingPipelineRepository) CommitArtifact(ctx context.Context, input recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error) {
	if existing, err := r.queries.GetRecordingArtifact(ctx, sqlc.GetRecordingArtifactParams{
		TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID),
	}); err == nil {
		return compareArtifactReplay(existing, input)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Artifact{}, fmt.Errorf("check recording artifact replay: %w", err)
	}
	row, err := r.queries.CommitRecordingArtifact(ctx, sqlc.CommitRecordingArtifactParams{
		RecordingID:       uuid(input.RecordingID),
		TenantID:          uuid(input.TenantID),
		RenderJobID:       uuid(input.RenderJobID),
		AttemptCount:      int32(input.AttemptCount),
		FencingGeneration: input.FencingGeneration,
		LeaseToken:        requiredTextValue(input.LeaseToken),
		LeaseOwner:        requiredTextValue(input.LeaseOwner),
		ObjectKey:         input.ObjectKey,
		ContentType:       input.ContentType,
		ByteSize:          input.ByteSize,
		Checksum:          input.Checksum,
		DurationMillis:    input.Duration.Milliseconds(),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.Artifact{}, recordingpipeline.ErrArtifactNotFound
	}
	if err != nil {
		if uniqueConstraintViolation(err, "recording_artifacts_pkey") {
			existing, getErr := r.queries.GetRecordingArtifact(ctx, sqlc.GetRecordingArtifactParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
			if getErr == nil {
				return compareArtifactReplay(existing, input)
			}
		}
		return recordingpipeline.Artifact{}, fmt.Errorf("commit recording artifact: %w", err)
	}
	return mapArtifact(row), nil
}

func compareArtifactReplay(row sqlc.RecordingArtifact, input recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error) {
	if row.RenderJobID.Bytes != input.RenderJobID.Bytes() || row.ObjectKey != input.ObjectKey ||
		row.ContentType != input.ContentType || row.ByteSize != input.ByteSize ||
		row.DurationMillis != input.Duration.Milliseconds() || !bytes.Equal(row.Checksum, input.Checksum) {
		return recordingpipeline.Artifact{}, recordingpipeline.ErrArtifactConflict
	}
	return mapArtifactRecord(row), nil
}

func (r RecordingPipelineRepository) transaction(ctx context.Context, work func(recordingPipelineQuerier) error) error {
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin recording pipeline transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	var queries sqlc.Querier = sqlc.New(tx)
	if r.decorate != nil {
		queries = r.decorate(queries)
	}
	if err := work(queries); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit recording pipeline transaction: %w", err)
	}
	return nil
}

func mapReservation(row sqlc.CreateRecordingReservationRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:               utilities.IDFromBytes(row.ID.Bytes),
		TenantID:         utilities.IDFromBytes(row.TenantID.Bytes),
		RoomID:           utilities.IDFromBytes(row.RoomID.Bytes),
		SessionID:        utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:      utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:   row.IdempotencyKey,
		ParticipantCount: int(row.ParticipantCount),
		MaxDuration:      time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:  row.InputBitrateBps,
		State:            recordingpipeline.ReservationState(row.State),
		StartsAt:         nullableTimestamp(row.StartsAt),
		EndsAt:           timestamp(row.EndsAt),
		UpdatedAt:        timestamp(row.UpdatedAt),
		CreatedAt:        timestamp(row.CreatedAt),
	}
}

func mapReleasedReservation(row sqlc.ReleaseRecordingReservationRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:               utilities.IDFromBytes(row.ID.Bytes),
		TenantID:         utilities.IDFromBytes(row.TenantID.Bytes),
		RoomID:           utilities.IDFromBytes(row.RoomID.Bytes),
		SessionID:        utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:      utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:   row.IdempotencyKey,
		ParticipantCount: int(row.ParticipantCount),
		MaxDuration:      time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:  row.InputBitrateBps,
		State:            recordingpipeline.ReservationState(row.State),
		StartsAt:         nullableTimestamp(row.StartsAt),
		EndsAt:           timestamp(row.EndsAt),
		UpdatedAt:        timestamp(row.UpdatedAt),
		CreatedAt:        timestamp(row.CreatedAt),
	}
}

func mapExpiredReservation(row sqlc.ExpireRecordingReservationsRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:               utilities.IDFromBytes(row.ID.Bytes),
		TenantID:         utilities.IDFromBytes(row.TenantID.Bytes),
		RoomID:           utilities.IDFromBytes(row.RoomID.Bytes),
		SessionID:        utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:      utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:   row.IdempotencyKey,
		ParticipantCount: int(row.ParticipantCount),
		MaxDuration:      time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:  row.InputBitrateBps,
		State:            recordingpipeline.ReservationState(row.State),
		StartsAt:         nullableTimestamp(row.StartsAt),
		EndsAt:           timestamp(row.EndsAt),
		UpdatedAt:        timestamp(row.UpdatedAt),
		CreatedAt:        timestamp(row.CreatedAt),
	}
}

func mapGetReservation(row sqlc.GetRecordingReservationRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:               utilities.IDFromBytes(row.ID.Bytes),
		TenantID:         utilities.IDFromBytes(row.TenantID.Bytes),
		RoomID:           utilities.IDFromBytes(row.RoomID.Bytes),
		SessionID:        utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:      utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:   row.IdempotencyKey,
		ParticipantCount: int(row.ParticipantCount),
		MaxDuration:      time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:  row.InputBitrateBps,
		State:            recordingpipeline.ReservationState(row.State),
		StartsAt:         nullableTimestamp(row.StartsAt),
		EndsAt:           timestamp(row.EndsAt),
		UpdatedAt:        timestamp(row.UpdatedAt),
		CreatedAt:        timestamp(row.CreatedAt),
	}
}

func mapReservationByKey(row sqlc.GetRecordingReservationByKeyRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:               utilities.IDFromBytes(row.ID.Bytes),
		TenantID:         utilities.IDFromBytes(row.TenantID.Bytes),
		RoomID:           utilities.IDFromBytes(row.RoomID.Bytes),
		SessionID:        utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:      utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:   row.IdempotencyKey,
		ParticipantCount: int(row.ParticipantCount),
		MaxDuration:      time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:  row.InputBitrateBps,
		State:            recordingpipeline.ReservationState(row.State),
		StartsAt:         nullableTimestamp(row.StartsAt),
		EndsAt:           timestamp(row.EndsAt),
		UpdatedAt:        timestamp(row.UpdatedAt),
		CreatedAt:        timestamp(row.CreatedAt),
	}
}

func mapPipeline(row sqlc.RecordingPipeline) recordingpipeline.Pipeline {
	return recordingpipeline.Pipeline{
		RecordingID:        utilities.IDFromBytes(row.RecordingID.Bytes),
		TenantID:           utilities.IDFromBytes(row.TenantID.Bytes),
		ReservationID:      utilities.IDFromBytes(row.ReservationID.Bytes),
		State:              recordingpipeline.State(row.State),
		CaptureCompletedAt: nullableTimestamp(row.CaptureCompletedAt),
		CommittedAt:        nullableTimestamp(row.CommittedAt),
		UpdatedAt:          timestamp(row.UpdatedAt),
		CreatedAt:          timestamp(row.CreatedAt),
	}
}

func mapRecordingJob(row sqlc.RecordingJob) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		SessionID:            utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapClaimJob(row sqlc.ClaimRecordingJobRow) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		SessionID:            utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapFailJob(row sqlc.FailRecordingJobRow) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		SessionID:            utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapRecoveredJob(row sqlc.RecoverExpiredRecordingJobsRow) recordingpipeline.Job {
	return recordingpipeline.Job{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		SessionID:            utilities.IDFromBytes(row.SessionID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		Kind:                 recordingpipeline.JobKind(row.Kind),
		IdempotencyKey:       row.IdempotencyKey,
		PayloadSchemaVersion: int(row.PayloadSchemaVersion),
		State:                recordingpipeline.JobState(row.State),
		Priority:             int(row.Priority),
		AvailableAt:          timestamp(row.AvailableAt),
		AttemptCount:         int(row.AttemptCount),
		AttemptLimit:         int(row.AttemptLimit),
		LeaseToken:           nullableTextPointer(row.LeaseToken),
		LeaseOwner:           nullableTextPointer(row.LeaseOwner),
		LeaseExpiresAt:       nullableTimestamp(row.LeaseExpiresAt),
		FencingGeneration:    row.FencingGeneration,
		ErrorCode:            nullableTextPointer(row.ErrorCode),
		ErrorDetail:          nullableTextPointer(row.ErrorDetail),
		TerminalAt:           nullableTimestamp(row.TerminalAt),
		UpdatedAt:            timestamp(row.UpdatedAt),
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapJobs(rows []sqlc.RecordingJob) []recordingpipeline.Job {
	jobs := make([]recordingpipeline.Job, 0, len(rows))
	for _, row := range rows {
		jobs = append(jobs, mapRecordingJob(row))
	}
	return jobs
}

func mapBundle(row sqlc.RecordingBundle) recordingpipeline.Bundle {
	return recordingpipeline.Bundle{
		ID:                   utilities.IDFromBytes(row.ID.Bytes),
		TenantID:             utilities.IDFromBytes(row.TenantID.Bytes),
		RecordingID:          utilities.IDFromBytes(row.RecordingID.Bytes),
		CaptureJobID:         utilities.IDFromBytes(row.CaptureJobID.Bytes),
		SequenceNumber:       row.SequenceNumber,
		FencingGeneration:    row.FencingGeneration,
		ObjectKey:            row.ObjectKey,
		ContentType:          row.ContentType,
		Codec:                row.Codec,
		Layer:                nullableTextPointer(row.Layer),
		ByteSize:             row.ByteSize,
		Checksum:             append([]byte(nil), row.Checksum...),
		MonotonicStartMillis: row.MonotonicStartMillis,
		MonotonicEndMillis:   row.MonotonicEndMillis,
		MediaStartMillis:     row.MediaStartMillis,
		MediaEndMillis:       row.MediaEndMillis,
		CreatedAt:            timestamp(row.CreatedAt),
	}
}

func mapArtifact(row sqlc.CommitRecordingArtifactRow) recordingpipeline.Artifact {
	return recordingpipeline.Artifact{
		RecordingID: utilities.IDFromBytes(row.RecordingID.Bytes),
		TenantID:    utilities.IDFromBytes(row.TenantID.Bytes),
		RenderJobID: utilities.IDFromBytes(row.RenderJobID.Bytes),
		ObjectKey:   row.ObjectKey,
		ContentType: row.ContentType,
		ByteSize:    row.ByteSize,
		Checksum:    append([]byte(nil), row.Checksum...),
		Duration:    time.Duration(row.DurationMillis) * time.Millisecond,
		CommittedAt: timestamp(row.CommittedAt),
		CreatedAt:   timestamp(row.CreatedAt),
	}
}

func mapArtifactRecord(row sqlc.RecordingArtifact) recordingpipeline.Artifact {
	return recordingpipeline.Artifact{
		RecordingID: utilities.IDFromBytes(row.RecordingID.Bytes),
		TenantID:    utilities.IDFromBytes(row.TenantID.Bytes),
		RenderJobID: utilities.IDFromBytes(row.RenderJobID.Bytes),
		ObjectKey:   row.ObjectKey,
		ContentType: row.ContentType,
		ByteSize:    row.ByteSize,
		Checksum:    append([]byte(nil), row.Checksum...),
		Duration:    time.Duration(row.DurationMillis) * time.Millisecond,
		CommittedAt: timestamp(row.CommittedAt),
		CreatedAt:   timestamp(row.CreatedAt),
	}
}

func mapPoolHealth(row sqlc.RecordingPoolHealth) recordingpipeline.PoolHealth {
	return recordingpipeline.PoolHealth{
		Role:          recordingpipeline.PoolRole(row.Role),
		AdmissionOpen: row.AdmissionOpen,
		ReadyCapacity: int(row.ReadyCapacity),
		Reason:        row.Reason,
		ObservedAt:    timestamp(row.ObservedAt),
		UpdatedAt:     timestamp(row.UpdatedAt),
	}
}

func nullableTextPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func requiredTextValue(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: true}
}

func timestamptzValue(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value, Valid: true}
}

var _ recordingpipeline.Repository = RecordingPipelineRepository{}
