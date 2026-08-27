package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingKeyAuthorityQuerier interface {
	AuthorizeRecordingJobLease(context.Context, sqlc.AuthorizeRecordingJobLeaseParams) (pgtype.UUID, error)
	GetRecordingDataKey(context.Context, sqlc.GetRecordingDataKeyParams) (sqlc.RecordingDataKey, error)
	InsertRecordingDataKey(context.Context, sqlc.InsertRecordingDataKeyParams) (sqlc.RecordingDataKey, error)
}

type RecordingKeyRepository struct {
	queries recordingKeyAuthorityQuerier
}

func NewRecordingKeyRepository(queries recordingKeyAuthorityQuerier) RecordingKeyRepository {
	return RecordingKeyRepository{queries: queries}
}

func (r RecordingKeyRepository) Authorize(ctx context.Context, authority recordingkeys.Authority) error {
	if r.queries == nil {
		return recordingkeys.ErrRepositoryUnavailable
	}
	tenantID, episodeID, recordingID, jobID, err := recordingKeyAuthorityIDs(authority)
	if err != nil {
		return err
	}
	_, err = r.queries.AuthorizeRecordingJobLease(ctx, sqlc.AuthorizeRecordingJobLeaseParams{
		JobID: uuid(jobID), TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID), AttemptCount: int32(authority.AttemptCount),
		FencingGeneration: authority.FencingGeneration, LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
		CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingkeys.ErrAuthorityMismatch
	}
	if err != nil {
		return fmt.Errorf("authorize recording key lease: %w", err)
	}
	return nil
}

func (r RecordingKeyRepository) Get(ctx context.Context, authority recordingkeys.Authority) (recordingkeys.Record, error) {
	if r.queries == nil {
		return recordingkeys.Record{}, recordingkeys.ErrRepositoryUnavailable
	}
	tenantID, episodeID, recordingID, jobID, err := recordingKeyAuthorityIDs(authority)
	if err != nil {
		return recordingkeys.Record{}, err
	}
	row, err := r.queries.GetRecordingDataKey(ctx, sqlc.GetRecordingDataKeyParams{
		RecordingID: uuid(recordingID), CaptureEpoch: authority.CaptureEpoch, TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), JobID: uuid(jobID), AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration,
		EnvelopeDigest: authority.EnvelopeDigest, LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingkeys.Record{}, recordingkeys.ErrKeyNotFound
	}
	if err != nil {
		return recordingkeys.Record{}, fmt.Errorf("get recording data key: %w", err)
	}
	return mapRecordingKey(row)
}

func (r RecordingKeyRepository) Save(ctx context.Context, record recordingkeys.Record) error {
	if r.queries == nil {
		return recordingkeys.ErrRepositoryUnavailable
	}
	recordingID, err := utilities.ParseID(record.Authority.RecordingID)
	if err != nil {
		return recordingkeys.ErrInvalidRequest
	}
	tenantID, err := utilities.ParseID(record.Authority.TenantID)
	if err != nil {
		return recordingkeys.ErrInvalidRequest
	}
	episodeID, err := utilities.ParseID(record.Authority.EpisodeID)
	if err != nil {
		return recordingkeys.ErrInvalidRequest
	}
	jobID, err := utilities.ParseID(record.Authority.JobID)
	if err != nil {
		return recordingkeys.ErrInvalidRequest
	}
	keyHandle, err := utilities.ParseID(record.Authority.KeyHandle)
	if err != nil {
		return recordingkeys.ErrInvalidRequest
	}
	_, err = r.queries.InsertRecordingDataKey(ctx, sqlc.InsertRecordingDataKeyParams{
		RecordingID: uuid(recordingID), CaptureEpoch: record.Authority.CaptureEpoch, TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), JobID: uuid(jobID),
		AttemptCount: int32(record.Authority.AttemptCount), FencingGeneration: record.Authority.FencingGeneration, KeyHandle: uuid(keyHandle),
		Environment: record.EncryptionContext.Environment, EnvelopeDigest: record.Authority.EnvelopeDigest, EncryptionContextDigest: record.ContextDigest, CiphertextBlob: record.CiphertextBlob,
		LeaseToken: requiredTextValue(record.Authority.LeaseToken), LeaseOwner: requiredTextValue(record.Authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(record.Authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) || uniqueViolation(err) {
		return recordingkeys.ErrKeyConflict
	}
	if err != nil {
		return fmt.Errorf("insert recording data key: %w", err)
	}
	return nil
}

func recordingKeyAuthorityIDs(authority recordingkeys.Authority) (utilities.ID, utilities.ID, utilities.ID, utilities.ID, error) {
	tenantID, err := utilities.ParseID(authority.TenantID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingkeys.ErrInvalidRequest
	}
	episodeID, err := utilities.ParseID(authority.EpisodeID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingkeys.ErrInvalidRequest
	}
	recordingID, err := utilities.ParseID(authority.RecordingID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingkeys.ErrInvalidRequest
	}
	jobID, err := utilities.ParseID(authority.JobID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingkeys.ErrInvalidRequest
	}
	return tenantID, episodeID, recordingID, jobID, nil
}

func mapRecordingKey(row sqlc.RecordingDataKey) (recordingkeys.Record, error) {
	if !row.RecordingID.Valid || !row.TenantID.Valid || !row.EpisodeID.Valid || !row.JobID.Valid || !row.KeyHandle.Valid || !row.CreatedAt.Valid {
		return recordingkeys.Record{}, recordingkeys.ErrKeyNotFound
	}
	return recordingkeys.Record{
		Authority: recordingkeys.Authority{
			TenantID: id(row.TenantID).String(), EpisodeID: id(row.EpisodeID).String(), RecordingID: id(row.RecordingID).String(), JobID: id(row.JobID).String(), KeyHandle: id(row.KeyHandle).String(),
			AttemptCount: int(row.AttemptCount), FencingGeneration: row.FencingGeneration, CaptureEpoch: row.CaptureEpoch, EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...),
		},
		CiphertextBlob:    append([]byte(nil), row.CiphertextBlob...),
		EncryptionContext: recordingkeys.EncryptionContext{Environment: row.Environment, TenantID: id(row.TenantID).String(), EpisodeID: id(row.EpisodeID).String(), RecordingID: id(row.RecordingID).String(), JobID: id(row.JobID).String(), CaptureEpoch: row.CaptureEpoch, BundleSchema: recordingkeys.BundleSchemaVersion, EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...)},
		ContextDigest:     append([]byte(nil), row.EncryptionContextDigest...), CreatedAt: timestamp(row.CreatedAt),
	}, nil
}

var _ recordingkeys.Repository = RecordingKeyRepository{}
