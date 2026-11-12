package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r RecordingRenderRepository) ReserveObject(ctx context.Context, input recordingrender.ReserveObjectInput, allocationID utilities.ID, objectKey string, _ time.Time) (recordingrender.Allocation, error) {
	if r.queries == nil {
		return recordingrender.Allocation{}, recordingrender.ErrRepositoryUnavailable
	}
	row, err := r.queries.ReserveRecordingRenderObject(ctx, sqlc.ReserveRecordingRenderObjectParams{
		AllocationID: uuid(allocationID), ReservationRequestID: uuid(input.ReservationRequestID), TenantID: uuid(input.Authority.TenantID), SpaceID: uuid(input.Authority.SpaceID),
		EpisodeID: uuid(input.Authority.EpisodeID), RecordingID: uuid(input.Authority.RecordingID), RenderJobID: uuid(input.Authority.JobID),
		RenderInputHandle: uuid(input.Authority.RenderInputHandle), ObjectHandle: uuid(input.Authority.ObjectHandle),
		AttemptCount: int32(input.Authority.AttemptCount), FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
		EnvelopeDigest: input.Authority.EnvelopeDigest, KeyHandle: uuid(input.Authority.KeyHandle), Purpose: string(input.Purpose), ObjectKey: objectKey,
		LeaseToken: requiredTextValue(input.Authority.LeaseToken), LeaseOwner: requiredTextValue(input.Authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(input.Authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.Allocation{}, recordingrender.ErrLeaseStale
	}
	if err != nil {
		if uniqueViolation(err) {
			replay, replayErr := r.queries.GetRecordingRenderObjectByReservation(ctx, sqlc.GetRecordingRenderObjectByReservationParams{
				ObjectHandle: uuid(input.Authority.ObjectHandle), ReservationRequestID: uuid(input.ReservationRequestID),
			})
			if replayErr == nil && renderAllocationAuthorityMatches(replay, input.Authority) && replay.Purpose == string(input.Purpose) {
				return mapRenderAllocation(replay, input.Authority), nil
			}
			return recordingrender.Allocation{}, recordingrender.ErrAllocationConflict
		}
		return recordingrender.Allocation{}, fmt.Errorf("reserve recording render object: %w", err)
	}
	return mapRenderAllocation(row, input.Authority), nil
}

func (r RecordingRenderRepository) GetObjectAllocation(ctx context.Context, authority recordingrender.Authority, allocationID utilities.ID) (recordingrender.Allocation, error) {
	if r.queries == nil {
		return recordingrender.Allocation{}, recordingrender.ErrRepositoryUnavailable
	}
	row, err := r.queries.GetRecordingRenderObject(ctx, renderObjectParams(authority, allocationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.Allocation{}, recordingrender.ErrAllocationNotFound
	}
	if err != nil {
		return recordingrender.Allocation{}, fmt.Errorf("get recording render object: %w", err)
	}
	return mapRenderAllocation(row, authority), nil
}

func (r RecordingRenderRepository) GetObjectAllocationByTokenHash(ctx context.Context, authority recordingrender.Authority, tokenHash []byte) (recordingrender.Allocation, error) {
	if r.queries == nil {
		return recordingrender.Allocation{}, recordingrender.ErrRepositoryUnavailable
	}
	params := renderObjectByTokenParams(authority, tokenHash)
	row, err := r.queries.GetRecordingRenderObjectByTokenHash(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.Allocation{}, recordingrender.ErrAllocationNotFound
	}
	if err != nil {
		return recordingrender.Allocation{}, fmt.Errorf("get recording render object by upload token: %w", err)
	}
	return mapRenderAllocation(row, authority), nil
}

func (r RecordingRenderRepository) FinalizeObject(ctx context.Context, allocation recordingrender.Allocation) (recordingrender.Allocation, error) {
	if r.queries == nil {
		return recordingrender.Allocation{}, recordingrender.ErrRepositoryUnavailable
	}
	row, err := r.queries.FinalizeRecordingRenderObject(ctx, sqlc.FinalizeRecordingRenderObjectParams{
		ExpectedContentType: requiredTextValue(allocation.ExpectedContentType), ExpectedByteSize: pgtype.Int8{Int64: allocation.ExpectedByteSize, Valid: true},
		ExpectedSha256: allocation.ExpectedSHA256, ExpectedDurationMillis: renderOptionalInt8(allocation.ExpectedDurationMillis),
		UploadTokenHash: allocation.UploadTokenHash, UploadExpiresAt: timestamptz(allocation.UploadExpiresAt), AllocationID: uuid(allocation.ID),
		LeaseToken: requiredTextValue(allocation.Authority.LeaseToken), LeaseOwner: requiredTextValue(allocation.Authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(allocation.Authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.Allocation{}, recordingrender.ErrLeaseStale
	}
	if err != nil {
		return recordingrender.Allocation{}, fmt.Errorf("finalize recording render object: %w", err)
	}
	return mapRenderAllocation(row, allocation.Authority), nil
}

func (r RecordingRenderRepository) CommitObject(ctx context.Context, allocation recordingrender.Allocation, facts objectstorage.ObjectFacts, committedAt time.Time) (recordingrender.CommittedObject, error) {
	if r.queries == nil {
		return recordingrender.CommittedObject{}, recordingrender.ErrRepositoryUnavailable
	}
	if allocation.State == "committed" {
		if !recordingrender.SameObjectFacts(allocation.Object, renderObjectFacts(facts)) {
			return recordingrender.CommittedObject{}, recordingrender.ErrObjectFactsMismatch
		}
		return committedRenderObject(allocation), nil
	}
	checksum, err := objectstorage.ObjectSHA256(facts)
	if err != nil {
		return recordingrender.CommittedObject{}, recordingrender.ErrObjectFactsMismatch
	}
	row, err := r.queries.CommitRecordingRenderObject(ctx, sqlc.CommitRecordingRenderObjectParams{
		ObjectVersion: requiredTextValue(facts.VersionID), ObjectEtag: requiredTextValue(facts.ETag), ObjectContentType: requiredTextValue(facts.ContentType),
		ObjectByteSize: pgtype.Int8{Int64: facts.Size, Valid: true}, ObjectSha256: checksum, CommittedAt: timestamptzValue(committedAt), AllocationID: uuid(allocation.ID),
		UploadTokenHash: allocation.UploadTokenHash,
		LeaseToken:      requiredTextValue(allocation.Authority.LeaseToken), LeaseOwner: requiredTextValue(allocation.Authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(allocation.Authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.CommittedObject{}, recordingrender.ErrLeaseStale
	}
	if err != nil {
		return recordingrender.CommittedObject{}, fmt.Errorf("commit recording render object: %w", err)
	}
	return committedRenderObject(mapRenderAllocation(row, allocation.Authority)), nil
}

func renderObjectParams(authority recordingrender.Authority, allocationID utilities.ID) sqlc.GetRecordingRenderObjectParams {
	return sqlc.GetRecordingRenderObjectParams{
		AllocationID: uuid(allocationID), RenderInputHandle: uuid(authority.RenderInputHandle), TenantID: uuid(authority.TenantID),
		SpaceID: uuid(authority.SpaceID), EpisodeID: uuid(authority.EpisodeID), RecordingID: uuid(authority.RecordingID), RenderJobID: uuid(authority.JobID),
		KeyHandle: uuid(authority.KeyHandle), ObjectHandle: uuid(authority.ObjectHandle), AttemptCount: int32(authority.AttemptCount),
		FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
		LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
	}
}

func renderObjectByTokenParams(authority recordingrender.Authority, tokenHash []byte) sqlc.GetRecordingRenderObjectByTokenHashParams {
	return sqlc.GetRecordingRenderObjectByTokenHashParams{
		UploadTokenHash: tokenHash, RenderInputHandle: uuid(authority.RenderInputHandle), TenantID: uuid(authority.TenantID),
		SpaceID: uuid(authority.SpaceID), EpisodeID: uuid(authority.EpisodeID), RecordingID: uuid(authority.RecordingID), RenderJobID: uuid(authority.JobID),
		KeyHandle: uuid(authority.KeyHandle), ObjectHandle: uuid(authority.ObjectHandle), AttemptCount: int32(authority.AttemptCount),
		FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
		LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
	}
}

func renderAllocationAuthorityMatches(row sqlc.RecordingRenderObjectAllocation, authority recordingrender.Authority) bool {
	return id(row.TenantID) == authority.TenantID && id(row.EpisodeID) == authority.EpisodeID && id(row.RecordingID) == authority.RecordingID && id(row.RenderJobID) == authority.JobID && id(row.RenderInputHandle) == authority.RenderInputHandle && id(row.ObjectHandle) == authority.ObjectHandle && int(row.AttemptCount) == authority.AttemptCount && row.FencingGeneration == authority.FencingGeneration && row.CaptureEpoch == authority.CaptureEpoch && bytes.Equal(row.EnvelopeDigest, authority.EnvelopeDigest)
}

func mapRenderAllocation(row sqlc.RecordingRenderObjectAllocation, authority recordingrender.Authority) recordingrender.Allocation {
	return recordingrender.Allocation{
		ID: id(row.ID), ReservationRequestID: id(row.ReservationRequestID), AllocationVersion: row.AllocationVersion, Authority: authority,
		Purpose: recordingrender.ObjectPurpose(row.Purpose), State: row.State,
		Object:              recordingrender.ObjectFacts{ObjectKey: row.ObjectKey, ObjectVersion: row.ObjectVersion.String, ObjectETag: row.ObjectEtag.String, ContentType: row.ObjectContentType.String, ByteSize: row.ObjectByteSize.Int64, SHA256: append([]byte(nil), row.ObjectSha256...)},
		ExpectedContentType: row.ExpectedContentType.String, ExpectedByteSize: row.ExpectedByteSize.Int64, ExpectedSHA256: append([]byte(nil), row.ExpectedSha256...),
		ExpectedDurationMillis: renderNullableInt64(row.ExpectedDurationMillis), UploadTokenHash: append([]byte(nil), row.UploadTokenHash...),
		UploadExpiresAt: nullableTimestamp(row.UploadExpiresAt), CommittedAt: nullableTimestamp(row.CommittedAt), CreatedAt: timestamp(row.CreatedAt),
	}
}
