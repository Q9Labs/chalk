package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingObjectAuthorityQuerier interface {
	AuthorizeRecordingJobLease(context.Context, sqlc.AuthorizeRecordingJobLeaseParams) (pgtype.UUID, error)
	GetRecordingCaptureAttemptEnvelope(context.Context, sqlc.GetRecordingCaptureAttemptEnvelopeParams) (sqlc.GetRecordingCaptureAttemptEnvelopeRow, error)
	GetRecordingBundleAllocation(context.Context, pgtype.UUID) (sqlc.RecordingBundleAllocation, error)
	GetRecordingBundleAllocationByReservationRequest(context.Context, pgtype.UUID) (sqlc.RecordingBundleAllocation, error)
	GetRecordingBundleAllocationByTokenHash(context.Context, []byte) (sqlc.RecordingBundleAllocation, error)
	ReserveRecordingBundleAllocation(context.Context, sqlc.ReserveRecordingBundleAllocationParams) (sqlc.ReserveRecordingBundleAllocationRow, error)
	InsertRecordingBundleAllocation(context.Context, sqlc.InsertRecordingBundleAllocationParams) (sqlc.RecordingBundleAllocation, error)
	FinalizeRecordingBundleAllocation(context.Context, sqlc.FinalizeRecordingBundleAllocationParams) (sqlc.RecordingBundleAllocation, error)
	CommitRecordingBundleAllocation(context.Context, sqlc.CommitRecordingBundleAllocationParams) (sqlc.CommitRecordingBundleAllocationRow, error)
}

func (r RecordingObjectRepository) BundleSchema(ctx context.Context, authority recordingobjects.Authority) (string, error) {
	_, _, _, jobID, _, err := authorityIDs(authority)
	if err != nil {
		return "", err
	}
	row, err := r.queries.GetRecordingCaptureAttemptEnvelope(ctx, sqlc.GetRecordingCaptureAttemptEnvelopeParams{
		JobID: uuid(jobID), EnvelopeDigest: authority.EnvelopeDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", recordingobjects.ErrAuthorityMismatch
	}
	if err != nil {
		return "", fmt.Errorf("load capture attempt envelope: %w", err)
	}
	envelope, err := recordingpipeline.DecodeRecorderJobEnvelope(row.EnvelopeBytes, row.EnvelopeDigest)
	if err != nil || envelope.JobID != authority.JobID || envelope.CaptureEpoch != authority.CaptureEpoch || envelope.ObjectHandle != authority.ObjectHandle {
		return "", recordingobjects.ErrAuthorityMismatch
	}
	return envelope.BundleSchemaVersion, nil
}

type RecordingObjectRepository struct {
	queries recordingObjectAuthorityQuerier
}

func NewRecordingObjectRepository(queries recordingObjectAuthorityQuerier) RecordingObjectRepository {
	return RecordingObjectRepository{queries: queries}
}

func (r RecordingObjectRepository) Authorize(ctx context.Context, authority recordingobjects.Authority) error {
	if r.queries == nil {
		return recordingobjects.ErrRepositoryUnavailable
	}
	tenantID, episodeID, recordingID, jobID, _, err := authorityIDs(authority)
	if err != nil {
		return err
	}
	_, err = r.queries.AuthorizeRecordingJobLease(ctx, sqlc.AuthorizeRecordingJobLeaseParams{
		JobID: uuid(jobID), TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID), AttemptCount: int32(authority.AttemptCount),
		FencingGeneration: authority.FencingGeneration, LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
		CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingobjects.ErrAuthorityMismatch
	}
	if err != nil {
		return fmt.Errorf("authorize recording object lease: %w", err)
	}
	return nil
}

func (r RecordingObjectRepository) GetAllocation(ctx context.Context, allocationID string) (recordingobjects.Allocation, error) {
	if r.queries == nil {
		return recordingobjects.Allocation{}, recordingobjects.ErrRepositoryUnavailable
	}
	row, err := r.queries.GetRecordingBundleAllocation(ctx, uuidString(allocationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
	}
	if err != nil {
		return recordingobjects.Allocation{}, fmt.Errorf("get recording bundle allocation: %w", err)
	}
	return mapRecordingObjectAllocation(row)
}

func (r RecordingObjectRepository) GetAllocationByReservationRequest(ctx context.Context, requestID string) (recordingobjects.Allocation, error) {
	if r.queries == nil {
		return recordingobjects.Allocation{}, recordingobjects.ErrRepositoryUnavailable
	}
	request, err := utilities.ParseID(requestID)
	if err != nil {
		return recordingobjects.Allocation{}, recordingobjects.ErrInvalidRequest
	}
	row, err := r.queries.GetRecordingBundleAllocationByReservationRequest(ctx, uuid(request))
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
	}
	if err != nil {
		return recordingobjects.Allocation{}, fmt.Errorf("get recording bundle allocation by reservation: %w", err)
	}
	return mapRecordingObjectAllocation(row)
}

func (r RecordingObjectRepository) GetAllocationByTokenHash(ctx context.Context, tokenHash []byte) (recordingobjects.Allocation, error) {
	if r.queries == nil {
		return recordingobjects.Allocation{}, recordingobjects.ErrRepositoryUnavailable
	}
	row, err := r.queries.GetRecordingBundleAllocationByTokenHash(ctx, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
	}
	if err != nil {
		return recordingobjects.Allocation{}, fmt.Errorf("get recording bundle allocation by token: %w", err)
	}
	return mapRecordingObjectAllocation(row)
}

var _ recordingobjects.Repository = RecordingObjectRepository{}
