package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
	limits := r.admissionLimits.WithDefaults()
	params := sqlc.CreateRecordingReservationParams{
		RecordingCap: int32(limits.RecordingCap), ParticipantCap: int32(limits.ParticipantCap), BitrateCapBps: limits.BitrateCapBPS(),
		EpisodeCount:          1,
		ParticipantCount:      int32(input.ParticipantCount),
		InputBitrateBps:       input.InputBitrateBPS,
		ID:                    uuid(input.ID),
		TenantID:              uuid(input.TenantID),
		SpaceID:               uuid(input.SpaceID),
		EpisodeID:             uuid(input.EpisodeID),
		RecordingID:           uuid(input.RecordingID),
		IdempotencyKey:        input.IdempotencyKey,
		RequestFingerprint:    fingerprint[:],
		PolicySnapshotVersion: input.PolicySnapshotVersion,
		MaxDurationSeconds:    int32(input.MaxDuration / time.Second),
		StartsAt:              timestamptz(input.StartsAt),
		EndsAt:                timestamptzValue(start.Add(input.MaxDuration)),
		CaptureJobID:          uuid(captureJobID),
		PayloadSchemaVersion:  recordingpipeline.DefaultPayloadSchemaVersion,
		Priority:              0,
		AvailableAt:           timestamptzValue(availableAt),
		AttemptLimit:          recordingpipeline.DefaultCaptureAttemptLimit,
	}
	if r.transactor == nil {
		return recordingpipeline.Reservation{}, errors.New("recording reservation admission requires a transaction")
	}
	var row sqlc.CreateRecordingReservationRow
	capacityUnavailable := false
	err := r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		if _, err := queries.LockRecordingCapacity(ctx); err != nil {
			return fmt.Errorf("lock recording capacity: %w", err)
		}
		if r.tenantLimits.AppliesTo(input.TenantID) && (r.tenantLimits.MaxConcurrentRecordings > 0 || r.tenantLimits.DailyRecordingMinutes > 0) {
			// Replays remain successful even when the tenant has used its last slot.
			_, err := queries.GetRecordingReservationFingerprint(ctx, sqlc.GetRecordingReservationFingerprintParams{TenantID: uuid(input.TenantID), IdempotencyKey: input.IdempotencyKey})
			if errors.Is(err, pgx.ErrNoRows) {
				now := r.now().UTC()
				usage, err := sqlc.New(tx).GetTenantRecordingUsage(ctx, sqlc.GetTenantRecordingUsageParams{TenantID: uuid(input.TenantID), ObservedAt: timestamptzValue(now), DayStart: timestamptzValue(now.Truncate(24 * time.Hour))})
				if err != nil {
					return fmt.Errorf("read tenant recording usage: %w", err)
				}
				if (r.tenantLimits.MaxConcurrentRecordings > 0 && usage.ActiveCount >= int64(r.tenantLimits.MaxConcurrentRecordings)) || (r.tenantLimits.DailyRecordingMinutes > 0 && usage.RecordingSeconds >= float64(r.tenantLimits.DailyRecordingMinutes)*60) {
					return tenantlimits.ErrRecordingLimitReached
				}
			} else if err != nil {
				return fmt.Errorf("check tenant recording replay: %w", err)
			}
		}
		var err error
		row, err = queries.CreateRecordingReservation(ctx, params)
		if err != nil {
			capacityUnavailable = errors.Is(err, pgx.ErrNoRows)
			return err
		}
		return r.insertRecordingPresentationBaseline(ctx, queries, input)
	})
	if capacityUnavailable {
		return recordingpipeline.Reservation{}, recordingpipeline.ErrRecordingCapacityUnavailable
	}
	if err != nil {
		if uniqueConstraintViolation(err, "recording_reservations_tenant_id_idempotency_key_key") {
			return r.reserveReplay(ctx, input, fingerprint)
		}
		return recordingpipeline.Reservation{}, fmt.Errorf("reserve recording capacity: %w", err)
	}
	slog.InfoContext(ctx, "Recording Capture preparation consumption", "event", "recording.preparation.consumed", "consumed", row.PreparationConsumed)
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
	var rows []sqlc.ExpireRecordingReservationsRow
	var metrics []webhookCommitMetric
	err := r.transaction(ctx, func(tx pgx.Tx, queries recordingPipelineQuerier) error {
		var err error
		rows, err = queries.ExpireRecordingReservations(ctx, timestamptzValue(now))
		if err != nil {
			return err
		}
		for _, row := range rows {
			metric, err := produceRecordingWebhook(ctx, tx, id(row.TenantID), id(row.RecordingID), "failed", timestamp(row.UpdatedAt), "capture_reservation_expired")
			if err != nil {
				return err
			}
			metrics = append(metrics, metric)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("expire recording reservations: %w", err)
	}
	reservations := make([]recordingpipeline.Reservation, 0, len(rows))
	for _, row := range rows {
		reservation := mapExpiredReservation(row)
		reservations = append(reservations, reservation)
		logExpiredRecordingReservation(ctx, reservation)
	}
	for _, metric := range metrics {
		metric.Record(ctx)
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
	return mapPoolHealth(sqlc.GetRecordingPoolHealthRow(row)), nil
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
