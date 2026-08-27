package postgres

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingObjectAuthorityQuerier interface {
	AuthorizeRecordingJobLease(context.Context, sqlc.AuthorizeRecordingJobLeaseParams) (pgtype.UUID, error)
	GetRecordingBundleAllocation(context.Context, pgtype.UUID) (sqlc.RecordingBundleAllocation, error)
	GetRecordingBundleAllocationByReservationRequest(context.Context, pgtype.UUID) (sqlc.RecordingBundleAllocation, error)
	GetRecordingBundleAllocationByTokenHash(context.Context, []byte) (sqlc.RecordingBundleAllocation, error)
	ReserveRecordingBundleAllocation(context.Context, sqlc.ReserveRecordingBundleAllocationParams) (sqlc.ReserveRecordingBundleAllocationRow, error)
	InsertRecordingBundleAllocation(context.Context, sqlc.InsertRecordingBundleAllocationParams) (sqlc.RecordingBundleAllocation, error)
	FinalizeRecordingBundleAllocation(context.Context, sqlc.FinalizeRecordingBundleAllocationParams) (sqlc.RecordingBundleAllocation, error)
	CommitRecordingBundleAllocation(context.Context, sqlc.CommitRecordingBundleAllocationParams) (sqlc.CommitRecordingBundleAllocationRow, error)
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

func (r RecordingObjectRepository) ReserveAllocation(ctx context.Context, input recordingobjects.ReserveInput) (recordingobjects.Allocation, error) {
	if r.queries == nil {
		return recordingobjects.Allocation{}, recordingobjects.ErrRepositoryUnavailable
	}
	tenantID, episodeID, recordingID, jobID, objectHandle, err := authorityIDs(input.Authority)
	if err != nil {
		return recordingobjects.Allocation{}, err
	}
	allocationID, err := utilities.ParseID(input.AllocationID)
	if err != nil {
		return recordingobjects.Allocation{}, recordingobjects.ErrInvalidRequest
	}
	reservationID, err := utilities.ParseID(input.ReservationRequestID)
	if err != nil {
		return recordingobjects.Allocation{}, recordingobjects.ErrInvalidRequest
	}
	row, err := r.queries.ReserveRecordingBundleAllocation(ctx, sqlc.ReserveRecordingBundleAllocationParams{
		RecordingID: uuid(recordingID), TenantID: uuid(tenantID), AllocationID: uuid(allocationID), EpisodeID: uuid(episodeID),
		JobID: uuid(jobID), ObjectHandle: uuid(objectHandle), ReservationRequestID: uuid(reservationID), AttemptCount: int32(input.Authority.AttemptCount),
		FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
		EnvelopeDigest: input.Authority.EnvelopeDigest, EncryptionContextDigest: input.EncryptionContextDigest,
		LeaseToken: requiredTextValue(input.Authority.LeaseToken), LeaseOwner: requiredTextValue(input.Authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(input.Authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationConflict
	}
	if err != nil {
		return recordingobjects.Allocation{}, fmt.Errorf("reserve recording bundle allocation: %w", err)
	}
	return mapRecordingObjectReservation(row)
}

func (r RecordingObjectRepository) CreateAllocation(ctx context.Context, allocation recordingobjects.Allocation) error {
	if r.queries == nil {
		return recordingobjects.ErrRepositoryUnavailable
	}
	tenantID, episodeID, recordingID, jobID, objectHandle, err := allocationIDs(allocation)
	if err != nil {
		return err
	}
	reservationID, err := utilities.ParseID(allocation.ReservationRequestID)
	if err != nil {
		return recordingobjects.ErrInvalidRequest
	}
	_, err = r.queries.InsertRecordingBundleAllocation(ctx, sqlc.InsertRecordingBundleAllocationParams{
		ID: uuidString(allocation.ID), TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID), JobID: uuid(jobID), ObjectHandle: uuid(objectHandle),
		ReservationRequestID: uuid(reservationID), AllocationVersion: allocation.AllocationVersion,
		AttemptCount: int32(allocation.Authority.AttemptCount), FencingGeneration: allocation.Authority.FencingGeneration, CaptureEpoch: allocation.Authority.CaptureEpoch, EnvelopeDigest: allocation.Authority.EnvelopeDigest,
		SequenceNumber: allocation.SequenceNumber, Codec: allocation.Codec, Layer: text(allocation.Layer), MonotonicStartMillis: allocation.MonotonicStartMillis, MonotonicEndMillis: allocation.MonotonicEndMillis,
		MediaStartMillis: allocation.MediaStartMillis, MediaEndMillis: allocation.MediaEndMillis, ObjectKey: allocation.ObjectKey, UploadTokenHash: allocation.TokenHash,
		ExpectedByteSize: allocation.ExpectedByteSize, ExpectedChecksum: allocation.ExpectedChecksumSHA256, ContentType: allocation.ContentType, ExpiresAt: timestamptzValue(allocation.ExpiresAt), EncryptionContextDigest: allocation.EncryptionContextDigest,
	})
	if errors.Is(err, pgx.ErrNoRows) || uniqueViolation(err) {
		return recordingobjects.ErrAllocationConflict
	}
	if err != nil {
		return fmt.Errorf("insert recording bundle allocation: %w", err)
	}
	return nil
}

func (r RecordingObjectRepository) FinalizeAllocation(ctx context.Context, allocation recordingobjects.Allocation) error {
	if r.queries == nil {
		return recordingobjects.ErrRepositoryUnavailable
	}
	tenantID, episodeID, recordingID, jobID, objectHandle, err := allocationIDs(allocation)
	if err != nil {
		return err
	}
	row, err := r.queries.FinalizeRecordingBundleAllocation(ctx, sqlc.FinalizeRecordingBundleAllocationParams{
		UploadTokenHash: allocation.TokenHash, ExpectedByteSize: allocation.ExpectedByteSize, ExpectedChecksum: allocation.ExpectedChecksumSHA256,
		ContentType: allocation.ContentType, ExpiresAt: timestamptzValue(allocation.ExpiresAt), Codec: allocation.Codec, Layer: text(allocation.Layer),
		MonotonicStartMillis: allocation.MonotonicStartMillis, MonotonicEndMillis: allocation.MonotonicEndMillis, MediaStartMillis: allocation.MediaStartMillis, MediaEndMillis: allocation.MediaEndMillis,
		ID: uuidString(allocation.ID), TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID), JobID: uuid(jobID), ObjectHandle: uuid(objectHandle),
		AttemptCount: int32(allocation.Authority.AttemptCount), FencingGeneration: allocation.Authority.FencingGeneration, CaptureEpoch: allocation.Authority.CaptureEpoch,
		EnvelopeDigest: allocation.Authority.EnvelopeDigest, EncryptionContextDigest: allocation.EncryptionContextDigest,
		LeaseToken: requiredTextValue(allocation.Authority.LeaseToken), LeaseOwner: requiredTextValue(allocation.Authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(allocation.Authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		existing, getErr := r.GetAllocation(ctx, allocation.ID)
		if getErr != nil {
			return recordingobjects.ErrAllocationConflict
		}
		if existing.State == "allocated" && sameFinalizedAllocation(existing, allocation) {
			return nil
		}
		return recordingobjects.ErrAllocationConflict
	}
	if err != nil {
		return fmt.Errorf("finalize recording bundle allocation: %w", err)
	}
	if row.State != "allocated" {
		return recordingobjects.ErrAllocationConflict
	}
	return nil
}

func (r RecordingObjectRepository) CommitAllocation(ctx context.Context, allocation recordingobjects.Allocation, facts objectstorage.ObjectFacts, manifestDigest []byte, committedAt time.Time) (recordingobjects.Bundle, error) {
	if r.queries == nil {
		return recordingobjects.Bundle{}, recordingobjects.ErrRepositoryUnavailable
	}
	tenantID, episodeID, recordingID, jobID, objectHandle, err := allocationIDs(allocation)
	if err != nil {
		return recordingobjects.Bundle{}, err
	}
	checksum := objectChecksum(facts)
	row, err := r.queries.CommitRecordingBundleAllocation(ctx, sqlc.CommitRecordingBundleAllocationParams{
		ObjectVersion: requiredTextValue(facts.VersionID), ObjectEtag: requiredTextValue(facts.ETag), ObjectChecksum: checksum, ManifestDigest: manifestDigest, CommittedAt: timestamptzValue(committedAt), ID: uuidString(allocation.ID),
		TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID), JobID: uuid(jobID), ObjectHandle: uuid(objectHandle),
		AttemptCount: int32(allocation.Authority.AttemptCount), FencingGeneration: allocation.Authority.FencingGeneration, CaptureEpoch: allocation.Authority.CaptureEpoch,
		EnvelopeDigest: allocation.Authority.EnvelopeDigest, EncryptionContextDigest: allocation.EncryptionContextDigest,
		LeaseToken: requiredTextValue(allocation.Authority.LeaseToken), LeaseOwner: requiredTextValue(allocation.Authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(allocation.Authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		existing, getErr := r.GetAllocation(ctx, allocation.ID)
		if getErr != nil {
			return recordingobjects.Bundle{}, recordingobjects.ErrAllocationConflict
		}
		if existing.State == "committed" && existing.CommittedAt != nil && existing.ObjectVersion == facts.VersionID && existing.ObjectETag == facts.ETag && bytesEqual(existing.ExpectedChecksumSHA256, checksum) && bytesEqual(existing.ManifestDigest, manifestDigest) {
			return bundleFromAllocation(existing, existing.ObjectVersion, existing.ObjectETag, checksum, existing.ManifestDigest, *existing.CommittedAt), nil
		}
		return recordingobjects.Bundle{}, recordingobjects.ErrAllocationConflict
	}
	if err != nil {
		return recordingobjects.Bundle{}, fmt.Errorf("commit recording bundle allocation: %w", err)
	}
	return bundleFromCommitRow(row), nil
}

func mapRecordingObjectAllocation(row sqlc.RecordingBundleAllocation) (recordingobjects.Allocation, error) {
	if !row.ID.Valid || !row.TenantID.Valid || !row.EpisodeID.Valid || !row.RecordingID.Valid || !row.JobID.Valid || !row.ObjectHandle.Valid || !row.ReservationRequestID.Valid || !row.ExpiresAt.Valid || !row.CreatedAt.Valid {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
	}
	return recordingobjects.Allocation{
		ID: id(row.ID).String(), ReservationRequestID: id(row.ReservationRequestID).String(), AllocationVersion: row.AllocationVersion,
		Authority:      recordingobjects.Authority{TenantID: id(row.TenantID).String(), EpisodeID: id(row.EpisodeID).String(), RecordingID: id(row.RecordingID).String(), JobID: id(row.JobID).String(), ObjectHandle: id(row.ObjectHandle).String(), AttemptCount: int(row.AttemptCount), FencingGeneration: row.FencingGeneration, CaptureEpoch: row.CaptureEpoch, EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...)},
		SequenceNumber: row.SequenceNumber, Codec: row.Codec, Layer: nullableTextPointer(row.Layer), MonotonicStartMillis: row.MonotonicStartMillis, MonotonicEndMillis: row.MonotonicEndMillis, MediaStartMillis: row.MediaStartMillis, MediaEndMillis: row.MediaEndMillis,
		ObjectKey: row.ObjectKey, TokenHash: append([]byte(nil), row.UploadTokenHash...), ExpectedByteSize: row.ExpectedByteSize, ExpectedChecksumSHA256: append([]byte(nil), row.ExpectedChecksum...), ContentType: row.ContentType, ExpiresAt: timestamp(row.ExpiresAt), EncryptionContextDigest: append([]byte(nil), row.EncryptionContextDigest...),
		ObjectVersion: nullableString(row.ObjectVersion), ObjectETag: nullableString(row.ObjectEtag), ObjectChecksumSHA256: append([]byte(nil), row.ObjectChecksum...), ManifestDigest: append([]byte(nil), row.ManifestDigest...), CommittedAt: nullableTimestamp(row.CommittedAt), CreatedAt: timestamp(row.CreatedAt), State: row.State,
	}, nil
}

func mapRecordingObjectReservation(row sqlc.ReserveRecordingBundleAllocationRow) (recordingobjects.Allocation, error) {
	if !row.ID.Valid || !row.TenantID.Valid || !row.EpisodeID.Valid || !row.RecordingID.Valid || !row.JobID.Valid || !row.ObjectHandle.Valid || !row.ReservationRequestID.Valid || !row.ExpiresAt.Valid || !row.CreatedAt.Valid {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
	}
	return recordingobjects.Allocation{
		ID: id(row.ID).String(), ReservationRequestID: id(row.ReservationRequestID).String(), AllocationVersion: row.AllocationVersion,
		Authority:      recordingobjects.Authority{TenantID: id(row.TenantID).String(), EpisodeID: id(row.EpisodeID).String(), RecordingID: id(row.RecordingID).String(), JobID: id(row.JobID).String(), ObjectHandle: id(row.ObjectHandle).String(), AttemptCount: int(row.AttemptCount), FencingGeneration: row.FencingGeneration, CaptureEpoch: row.CaptureEpoch, EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...)},
		SequenceNumber: row.SequenceNumber, Codec: row.Codec, Layer: nullableTextPointer(row.Layer), MonotonicStartMillis: row.MonotonicStartMillis, MonotonicEndMillis: row.MonotonicEndMillis, MediaStartMillis: row.MediaStartMillis, MediaEndMillis: row.MediaEndMillis,
		ObjectKey: row.ObjectKey, TokenHash: append([]byte(nil), row.UploadTokenHash...), ExpectedByteSize: row.ExpectedByteSize, ExpectedChecksumSHA256: append([]byte(nil), row.ExpectedChecksum...), ContentType: row.ContentType, ExpiresAt: timestamp(row.ExpiresAt), EncryptionContextDigest: append([]byte(nil), row.EncryptionContextDigest...),
		ObjectVersion: nullableString(row.ObjectVersion), ObjectETag: nullableString(row.ObjectEtag), ObjectChecksumSHA256: append([]byte(nil), row.ObjectChecksum...), ManifestDigest: append([]byte(nil), row.ManifestDigest...), CommittedAt: nullableTimestamp(row.CommittedAt), CreatedAt: timestamp(row.CreatedAt), State: row.State,
	}, nil
}

func mapRecordingObjectCommit(row sqlc.CommitRecordingBundleAllocationRow) recordingobjects.Bundle {
	allocation := recordingobjects.Allocation{
		ID: id(row.ID).String(), ReservationRequestID: id(row.ReservationRequestID).String(), AllocationVersion: row.AllocationVersion,
		Authority:      recordingobjects.Authority{TenantID: id(row.TenantID).String(), EpisodeID: id(row.EpisodeID).String(), RecordingID: id(row.RecordingID).String(), JobID: id(row.JobID).String(), ObjectHandle: id(row.ObjectHandle).String(), AttemptCount: int(row.AttemptCount), FencingGeneration: row.FencingGeneration, CaptureEpoch: row.CaptureEpoch, EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...)},
		SequenceNumber: row.SequenceNumber, Codec: row.Codec, Layer: nullableTextPointer(row.Layer), MonotonicStartMillis: row.MonotonicStartMillis, MonotonicEndMillis: row.MonotonicEndMillis, MediaStartMillis: row.MediaStartMillis, MediaEndMillis: row.MediaEndMillis,
		ObjectKey: row.ObjectKey, TokenHash: append([]byte(nil), row.UploadTokenHash...), ExpectedByteSize: row.ExpectedByteSize, ExpectedChecksumSHA256: append([]byte(nil), row.ExpectedChecksum...), ContentType: row.ContentType, ExpiresAt: timestamp(row.ExpiresAt), EncryptionContextDigest: append([]byte(nil), row.EncryptionContextDigest...),
		ObjectVersion: nullableString(row.ObjectVersion), ObjectETag: nullableString(row.ObjectEtag), ObjectChecksumSHA256: append([]byte(nil), row.ObjectChecksum...), ManifestDigest: append([]byte(nil), row.ManifestDigest...), CommittedAt: nullableTimestamp(row.CommittedAt), CreatedAt: timestamp(row.CreatedAt), State: row.State,
	}
	return recordingobjects.Bundle{Allocation: allocation, ManifestDigest: append([]byte(nil), row.ManifestDigest...), ObjectVersion: nullableString(row.ObjectVersion), ObjectETag: nullableString(row.ObjectEtag), ObjectChecksumSHA256: append([]byte(nil), row.ObjectChecksum...), CommittedAt: timestamp(row.CommittedAt)}
}

func bundleFromCommitRow(row sqlc.CommitRecordingBundleAllocationRow) recordingobjects.Bundle {
	return mapRecordingObjectCommit(row)
}

func bundleFromAllocation(allocation recordingobjects.Allocation, version, etag string, checksum, manifest []byte, committedAt time.Time) recordingobjects.Bundle {
	allocation.ObjectVersion, allocation.ObjectETag, allocation.ObjectChecksumSHA256, allocation.ManifestDigest, allocation.CommittedAt, allocation.State = version, etag, append([]byte(nil), checksum...), append([]byte(nil), manifest...), &committedAt, "committed"
	return recordingobjects.Bundle{Allocation: allocation, ManifestDigest: append([]byte(nil), manifest...), ObjectVersion: version, ObjectETag: etag, ObjectChecksumSHA256: append([]byte(nil), checksum...), CommittedAt: committedAt}
}

func allocationIDs(allocation recordingobjects.Allocation) (utilities.ID, utilities.ID, utilities.ID, utilities.ID, utilities.ID, error) {
	return authorityIDs(allocation.Authority)
}

func authorityIDs(authority recordingobjects.Authority) (utilities.ID, utilities.ID, utilities.ID, utilities.ID, utilities.ID, error) {
	tenantID, err := utilities.ParseID(authority.TenantID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingobjects.ErrInvalidRequest
	}
	episodeID, err := utilities.ParseID(authority.EpisodeID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingobjects.ErrInvalidRequest
	}
	recordingID, err := utilities.ParseID(authority.RecordingID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingobjects.ErrInvalidRequest
	}
	jobID, err := utilities.ParseID(authority.JobID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingobjects.ErrInvalidRequest
	}
	objectHandle, err := utilities.ParseID(authority.ObjectHandle)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, recordingobjects.ErrInvalidRequest
	}
	return tenantID, episodeID, recordingID, jobID, objectHandle, nil
}

func objectChecksum(facts objectstorage.ObjectFacts) []byte {
	if facts.ChecksumSHA256 == "" {
		return nil
	}
	decoded, _ := base64.StdEncoding.Strict().DecodeString(facts.ChecksumSHA256)
	return decoded
}

func sameFinalizedAllocation(left, right recordingobjects.Allocation) bool {
	return left.ID == right.ID && left.State == right.State && left.ExpectedByteSize == right.ExpectedByteSize && left.ContentType == right.ContentType && left.ExpiresAt.Equal(right.ExpiresAt) && left.Codec == right.Codec && sameLayer(left.Layer, right.Layer) && left.MonotonicStartMillis == right.MonotonicStartMillis && left.MonotonicEndMillis == right.MonotonicEndMillis && left.MediaStartMillis == right.MediaStartMillis && left.MediaEndMillis == right.MediaEndMillis && bytesEqual(left.TokenHash, right.TokenHash) && bytesEqual(left.ExpectedChecksumSHA256, right.ExpectedChecksumSHA256)
}

func sameLayer(left, right *string) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

var _ recordingobjects.Repository = RecordingObjectRepository{}
