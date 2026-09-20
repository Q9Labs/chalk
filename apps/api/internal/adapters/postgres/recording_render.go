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
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RecordingRenderRepository struct {
	queries              sqlc.Querier
	pool                 *pgxpool.Pool
	transcriptionEnabled bool
}

func NewRecordingRenderRepositoryWithPool(pool *pgxpool.Pool, transcriptionEnabled bool) RecordingRenderRepository {
	if pool == nil {
		return RecordingRenderRepository{transcriptionEnabled: transcriptionEnabled}
	}
	return RecordingRenderRepository{queries: sqlc.New(pool), pool: pool, transcriptionEnabled: transcriptionEnabled}
}

func (r RecordingRenderRepository) ResolveInput(ctx context.Context, authority recordingrender.Authority) (recordingrender.StoredInput, error) {
	if r.pool == nil {
		return recordingrender.StoredInput{}, recordingrender.ErrRepositoryUnavailable
	}
	var stored recordingrender.StoredInput
	err := r.transaction(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadWrite}, func(queries sqlc.Querier) error {
		inputRow, err := queries.AuthorizeRecordingRenderInput(ctx, renderAuthorityParams(authority))
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingrender.ErrLeaseStale
		}
		if err != nil {
			return fmt.Errorf("authorize recording render input: %w", err)
		}
		policy, err := queries.GetRecordingTranscriptionPolicyForCommit(ctx, sqlc.GetRecordingTranscriptionPolicyForCommitParams{
			TenantID: uuid(authority.TenantID), SpaceID: uuid(authority.SpaceID), EpisodeID: uuid(authority.EpisodeID), RecordingID: uuid(authority.RecordingID),
		})
		if err != nil {
			return fmt.Errorf("load recording render transcription policy: %w", err)
		}
		presentation, err := queries.GetRecordingPresentationForRender(ctx, sqlc.GetRecordingPresentationForRenderParams{
			TenantID: uuid(authority.TenantID), SpaceID: uuid(authority.SpaceID), EpisodeID: uuid(authority.EpisodeID),
			RecordingID: uuid(authority.RecordingID), PresentationHandle: inputRow.PresentationHandle, CaptureEpoch: authority.CaptureEpoch,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingrender.ErrInputIncomplete
		}
		if err != nil {
			return fmt.Errorf("load recording presentation for render: %w", err)
		}
		if inputRow.PresentationHandle != presentation.PresentationHandle || inputRow.PresentationSchemaVersion != presentation.SchemaVersion || inputRow.PresentationProfileVersion != presentation.ProfileVersion || inputRow.PresentationDurationMillis != presentation.DurationMillis || !bytes.Equal(inputRow.PresentationSha256, presentation.PresentationSha256) || !timestamp(inputRow.CaptureReadyAt).Equal(timestamp(presentation.CaptureReadyAt)) {
			return recordingrender.ErrAuthorityMismatch
		}
		assetRows, err := queries.ListRecordingPresentationAssetsForRender(ctx, sqlc.ListRecordingPresentationAssetsForRenderParams{
			TenantID: uuid(authority.TenantID), RecordingID: uuid(authority.RecordingID), PresentationHandle: inputRow.PresentationHandle,
		})
		if err != nil {
			return fmt.Errorf("list recording presentation assets for render: %w", err)
		}
		assets, err := mapRenderPresentationAssets(assetRows)
		if err != nil {
			return err
		}
		captureRows, err := queries.ListRecordingRenderCaptureObjects(ctx, sqlc.ListRecordingRenderCaptureObjectsParams{
			RenderInputHandle: uuid(authority.RenderInputHandle), TenantID: uuid(authority.TenantID), RenderJobID: uuid(authority.JobID),
			AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration,
		})
		if err != nil {
			return fmt.Errorf("list recording capture bundle for render: %w", err)
		}
		capture, err := mapRenderCaptureObjects(captureRows)
		if err != nil {
			return err
		}
		stored = recordingrender.StoredInput{
			SchemaVersion:     recordingrender.InputSchemaVersion,
			TranscriptionMode: artifactpolicy.TranscriptionMode(policy.TranscriptionMode),
			Authority:         authority,
			Capture:           capture,
			Presentation: recordingrender.Presentation{
				Handle: id(presentation.PresentationHandle), SchemaVersion: presentation.SchemaVersion,
				ProfileVersion: presentation.ProfileVersion, DurationMillis: presentation.DurationMillis,
				SHA256: append([]byte(nil), presentation.PresentationSha256...), CaptureReadyAt: timestamp(presentation.CaptureReadyAt),
				Object: recordingrender.ObjectFacts{
					ObjectKey: presentation.PresentationObjectKey, ObjectVersion: presentation.PresentationObjectVersion,
					ObjectETag: presentation.PresentationObjectEtag, ContentType: presentation.PresentationContentType,
					ByteSize: presentation.PresentationByteSize, SHA256: append([]byte(nil), presentation.PresentationSha256...),
				},
				AssetManifest: recordingrender.ObjectFacts{
					ObjectKey: presentation.AssetManifestObjectKey, ObjectVersion: presentation.AssetManifestObjectVersion,
					ObjectETag: presentation.AssetManifestObjectEtag, ContentType: presentation.AssetManifestContentType,
					ByteSize: presentation.AssetManifestByteSize, SHA256: append([]byte(nil), presentation.AssetManifestSha256...),
				},
				Assets: assets,
			},
		}
		return nil
	})
	return stored, err
}

func (r RecordingRenderRepository) GetCaptureKey(ctx context.Context, input recordingrender.AccessKeyInput) (recordingrender.EncryptedKey, error) {
	if r.queries == nil {
		return recordingrender.EncryptedKey{}, recordingrender.ErrRepositoryUnavailable
	}
	authority := input.Authority
	row, err := r.queries.GetRecordingRenderCaptureKey(ctx, sqlc.GetRecordingRenderCaptureKeyParams{
		RequestedCaptureEpoch: input.CaptureEpoch,
		RenderInputHandle:     uuid(authority.RenderInputHandle), TenantID: uuid(authority.TenantID), SpaceID: uuid(authority.SpaceID), EpisodeID: uuid(authority.EpisodeID), RecordingID: uuid(authority.RecordingID),
		RenderJobID: uuid(authority.JobID), AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration,
		CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest, KeyHandle: uuid(authority.KeyHandle), ObjectHandle: uuid(authority.ObjectHandle),
		LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner),
		LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.EncryptedKey{}, recordingrender.ErrKeyNotFound
	}
	if err != nil {
		return recordingrender.EncryptedKey{}, fmt.Errorf("get recording render capture key: %w", err)
	}
	context := recordingkeys.EncryptionContext{
		Environment: row.Environment, TenantID: id(row.TenantID).String(), EpisodeID: id(row.EpisodeID).String(),
		RecordingID: id(row.RecordingID).String(), JobID: id(row.JobID).String(), CaptureEpoch: row.CaptureEpoch,
		BundleSchema: recordingkeys.BundleSchemaVersion, EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...),
	}
	if !bytes.Equal(context.Digest(), row.EncryptionContextDigest) {
		return recordingrender.EncryptedKey{}, recordingrender.ErrKeyNotFound
	}
	return recordingrender.EncryptedKey{KeyHandle: id(row.KeyHandle), CiphertextBlob: append([]byte(nil), row.CiphertextBlob...), Context: context}, nil
}

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

func (r RecordingRenderRepository) Commit(ctx context.Context, input recordingrender.CommitInput, committedAt time.Time) (recordingrender.CommitResult, error) {
	if r.pool == nil || r.queries == nil {
		return recordingrender.CommitResult{}, recordingrender.ErrRepositoryUnavailable
	}
	if replay, err := getRecordingRenderCommit(ctx, r.queries, input); err == nil {
		return replay, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.CommitResult{}, err
	}
	var result recordingrender.CommitResult
	err := r.transaction(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable}, func(queries sqlc.Querier) error {
		if replay, err := getRecordingRenderCommit(ctx, queries, input); err == nil {
			result = replay
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		locked, err := queries.LockRecordingRenderCommitAuthority(ctx, renderCommitAuthorityParams(input.Authority))
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingrender.ErrLeaseStale
		}
		if err != nil {
			return fmt.Errorf("lock recording render commit authority: %w", err)
		}
		if !bytes.Equal(locked.PresentationSha256, input.PresentationSHA256) || locked.PresentationDurationMillis != input.DurationMillis {
			return recordingrender.ErrCommitConflict
		}
		if err := verifyRenderCommitObject(ctx, queries, input.Authority, input.Video); err != nil {
			return err
		}
		if input.TranscriptionSource != nil {
			if err := verifyRenderCommitObject(ctx, queries, input.Authority, input.TranscriptionSource.Manifest); err != nil {
				return err
			}
			for _, chunk := range input.TranscriptionSource.Chunks {
				if err := verifyRenderCommitObject(ctx, queries, input.Authority, chunk.Object); err != nil {
					return err
				}
			}
		}
		admission, err := commitRecordingTranscriptionAdmission(ctx, queries, renderTranscriptionAdmission(input, committedAt))
		if err != nil {
			return mapRenderTranscriptionError(err)
		}
		if !r.transcriptionEnabled && admission.Source != nil {
			return recordingrender.ErrTranscriptionUnavailable
		}
		var sourceID pgtype.UUID
		var transcription *recordingrender.TranscriptionResult
		if admission.Source != nil {
			sourceID = uuid(input.Authority.RecordingID)
			transcription = &recordingrender.TranscriptionResult{SourceID: input.Authority.RecordingID, JobIDs: append([]utilities.ID(nil), admission.JobIDs...)}
		}
		jobIDs := make([]pgtype.UUID, 0, len(admission.JobIDs))
		for _, jobID := range admission.JobIDs {
			jobIDs = append(jobIDs, uuid(jobID))
		}
		artifact, err := queries.CompleteRecordingRender(ctx, sqlc.CompleteRecordingRenderParams{
			RenderJobID: uuid(input.Authority.JobID), TenantID: uuid(input.Authority.TenantID), RecordingID: uuid(input.Authority.RecordingID),
			AttemptCount: int32(input.Authority.AttemptCount), FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
			RenderInputHandle: uuid(input.Authority.RenderInputHandle), CommitDigest: input.CommitDigest, PresentationSha256: input.PresentationSHA256,
			DurationMillis: input.DurationMillis, VideoAllocationID: uuid(input.Video.AllocationID), FfprobeFactsDigest: input.FFprobeFactsDigest,
			TranscriptionSourceID: sourceID, TranscriptionJobIds: jobIDs, CommittedAt: timestamptzValue(committedAt),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingrender.ErrCommitConflict
		}
		if err != nil {
			return fmt.Errorf("complete recording render: %w", err)
		}
		result = recordingrender.CommitResult{Artifact: mapCompletedRenderArtifact(artifact), Transcription: transcription}
		return nil
	})
	if err == nil {
		return result, nil
	}
	if replay, replayErr := getRecordingRenderCommit(ctx, r.queries, input); replayErr == nil {
		return replay, nil
	}
	return recordingrender.CommitResult{}, err
}

func (r RecordingRenderRepository) transaction(ctx context.Context, options pgx.TxOptions, work func(sqlc.Querier) error) error {
	tx, err := r.pool.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := work(sqlc.New(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func renderAuthorityParams(authority recordingrender.Authority) sqlc.AuthorizeRecordingRenderInputParams {
	return sqlc.AuthorizeRecordingRenderInputParams{
		RenderInputHandle: uuid(authority.RenderInputHandle), TenantID: uuid(authority.TenantID), SpaceID: uuid(authority.SpaceID),
		EpisodeID: uuid(authority.EpisodeID), RecordingID: uuid(authority.RecordingID), RenderJobID: uuid(authority.JobID),
		AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch,
		EnvelopeDigest: authority.EnvelopeDigest, KeyHandle: uuid(authority.KeyHandle), ObjectHandle: uuid(authority.ObjectHandle),
		LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
	}
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

func renderCommitAuthorityParams(authority recordingrender.Authority) sqlc.LockRecordingRenderCommitAuthorityParams {
	return sqlc.LockRecordingRenderCommitAuthorityParams{
		RenderInputHandle: uuid(authority.RenderInputHandle), TenantID: uuid(authority.TenantID), SpaceID: uuid(authority.SpaceID), EpisodeID: uuid(authority.EpisodeID), RecordingID: uuid(authority.RecordingID), RenderJobID: uuid(authority.JobID),
		AttemptCount: int32(authority.AttemptCount), FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
		KeyHandle: uuid(authority.KeyHandle), ObjectHandle: uuid(authority.ObjectHandle),
		LeaseToken: requiredTextValue(authority.LeaseToken), LeaseOwner: requiredTextValue(authority.LeaseOwner), LeaseExpiresAt: timestamptzValue(authority.LeaseExpiresAt),
	}
}

func mapRenderCaptureObjects(rows []sqlc.ListRecordingRenderCaptureObjectsRow) ([]recordingrender.CaptureObject, error) {
	objects := make([]recordingrender.CaptureObject, 0, len(rows))
	for _, row := range rows {
		if !row.CaptureJobID.Valid || !row.KeyHandle.Valid {
			return nil, recordingrender.ErrInputIncomplete
		}
		objects = append(objects, recordingrender.CaptureObject{
			ObjectFacts:  recordingrender.ObjectFacts{ObjectKey: row.ObjectKey, ObjectVersion: row.ObjectVersion.String, ObjectETag: row.ObjectEtag.String, ContentType: row.ContentType, ByteSize: row.ByteSize, SHA256: append([]byte(nil), row.Sha256...)},
			CaptureEpoch: row.CaptureEpoch, CaptureJobID: id(row.CaptureJobID), KeyHandle: id(row.KeyHandle), EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...),
			SequenceNumber: row.SequenceNumber, MonotonicStartMillis: row.MonotonicStartMillis, MonotonicEndMillis: row.MonotonicEndMillis,
			MediaStartMillis: row.MediaStartMillis, MediaEndMillis: row.MediaEndMillis, Codec: row.Codec, Layer: nullableTextPointer(row.Layer),
		})
	}
	return objects, nil
}

func mapRenderPresentationAssets(rows []sqlc.ListRecordingPresentationAssetsForRenderRow) ([]recordingrender.ObjectFacts, error) {
	assets := make([]recordingrender.ObjectFacts, 0, len(rows))
	for index, row := range rows {
		if int(row.Ordinal) != index {
			return nil, recordingrender.ErrInputIncomplete
		}
		assets = append(assets, recordingrender.ObjectFacts{ObjectKey: row.ObjectKey, ObjectVersion: row.ObjectVersion, ObjectETag: row.ObjectEtag, ContentType: row.ContentType, ByteSize: row.ByteSize, SHA256: append([]byte(nil), row.Sha256...)})
	}
	return assets, nil
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

func committedRenderObject(allocation recordingrender.Allocation) recordingrender.CommittedObject {
	committedAt := time.Time{}
	if allocation.CommittedAt != nil {
		committedAt = *allocation.CommittedAt
	}
	return recordingrender.CommittedObject{
		ReservedObject: recordingrender.ReservedObject{AllocationID: allocation.ID, ObjectKey: allocation.Object.ObjectKey, Purpose: allocation.Purpose, AllocationVersion: allocation.AllocationVersion},
		Object:         allocation.Object, DurationMillis: cloneRenderInt64(allocation.ExpectedDurationMillis), CommittedAt: committedAt,
	}
}

func renderObjectFacts(facts objectstorage.ObjectFacts) recordingrender.ObjectFacts {
	checksum, _ := objectstorage.ObjectSHA256(facts)
	return recordingrender.ObjectFacts{ObjectKey: facts.Key, ObjectVersion: facts.VersionID, ObjectETag: facts.ETag, ContentType: facts.ContentType, ByteSize: facts.Size, SHA256: checksum}
}

func verifyRenderCommitObject(ctx context.Context, queries sqlc.Querier, authority recordingrender.Authority, reference recordingrender.CommitObjectReference) error {
	row, err := queries.GetRecordingRenderObject(ctx, renderObjectParams(authority, reference.AllocationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingrender.ErrAllocationNotFound
	}
	if err != nil {
		return fmt.Errorf("verify recording render commit object: %w", err)
	}
	allocation := mapRenderAllocation(row, authority)
	if allocation.State != "committed" || allocation.Purpose != reference.Purpose || !recordingrender.SameObjectFacts(allocation.Object, reference.Object) || !equalRenderInt64(allocation.ExpectedDurationMillis, reference.DurationMillis) {
		return recordingrender.ErrObjectFactsMismatch
	}
	return nil
}

func renderTranscriptionAdmission(input recordingrender.CommitInput, committedAt time.Time) transcripts.RenderAdmissionInput {
	admission := transcripts.RenderAdmissionInput{
		TenantID: input.Authority.TenantID, SpaceID: input.Authority.SpaceID, EpisodeID: input.Authority.EpisodeID,
		RecordingID: input.Authority.RecordingID, RenderJobID: input.Authority.JobID, Attempt: input.Authority.AttemptCount,
		FencingGeneration: input.Authority.FencingGeneration, CaptureEpoch: input.Authority.CaptureEpoch,
		CommitDigest: input.CommitDigest, PresentationSHA256: input.PresentationSHA256, CommittedAt: committedAt,
	}
	if input.TranscriptionSource == nil {
		return admission
	}
	manifest := input.TranscriptionSource.Manifest
	admission.Manifest = &transcripts.CommittedObject{
		AllocationID: manifest.AllocationID, Key: manifest.Object.ObjectKey, ObjectVersion: manifest.Object.ObjectVersion,
		ETag: manifest.Object.ObjectETag, SHA256: append([]byte(nil), manifest.Object.SHA256...), Size: manifest.Object.ByteSize, ContentType: manifest.Object.ContentType,
	}
	admission.Chunks = make([]transcripts.ChunkInput, 0, len(input.TranscriptionSource.Chunks))
	for _, chunk := range input.TranscriptionSource.Chunks {
		admission.Chunks = append(admission.Chunks, transcripts.ChunkInput{
			ID: chunk.ChunkID, Index: chunk.Index, Generation: chunk.Generation, StartMS: chunk.StartMillis, EndMS: chunk.EndMillis,
			SourceStartMS: chunk.SourceStartMillis, SourceEndMS: chunk.SourceEndMillis, ParticipantRef: chunk.ParticipantRef,
			ParticipantGeneration: chunk.ParticipantGeneration, TrackID: chunk.TrackID, TrackEpoch: chunk.TrackEpoch,
			IdentityKind: chunk.IdentityKind, TrackClass: chunk.TrackClass, DisplayNameSnapshot: chunk.DisplayNameSnapshot, Overlap: chunk.Overlap,
			StorageKey: chunk.Object.Object.ObjectKey, AllocationID: chunk.Object.AllocationID, ObjectVersion: chunk.Object.Object.ObjectVersion,
			ObjectETag: chunk.Object.Object.ObjectETag, Checksum: append([]byte(nil), chunk.Object.Object.SHA256...), Size: chunk.Object.Object.ByteSize, ContentType: chunk.Object.Object.ContentType,
		})
	}
	return admission
}

func mapRenderTranscriptionError(err error) error {
	switch {
	case errors.Is(err, transcripts.ErrRecordingNotFound):
		return recordingrender.ErrInputNotFound
	case errors.Is(err, transcripts.ErrSourceConflict), errors.Is(err, transcripts.ErrTranscriptionDisabled), errors.Is(err, transcripts.ErrSourceExpired):
		return recordingrender.ErrCommitConflict
	case errors.Is(err, transcripts.ErrInvalidManifest), errors.Is(err, transcripts.ErrInvalidChunk), errors.Is(err, transcripts.ErrInvalidArtifact), errors.Is(err, transcripts.ErrInvalidTranscriptField):
		return recordingrender.ErrInvalidRequest
	default:
		return fmt.Errorf("admit recording transcription source: %w", err)
	}
}

func getRecordingRenderCommit(ctx context.Context, queries sqlc.Querier, input recordingrender.CommitInput) (recordingrender.CommitResult, error) {
	row, err := queries.GetRecordingRenderCommit(ctx, sqlc.GetRecordingRenderCommitParams{
		RenderJobID: uuid(input.Authority.JobID), TenantID: uuid(input.Authority.TenantID), SpaceID: uuid(input.Authority.SpaceID), EpisodeID: uuid(input.Authority.EpisodeID), RecordingID: uuid(input.Authority.RecordingID),
		AttemptCount: int32(input.Authority.AttemptCount), FencingGeneration: input.Authority.FencingGeneration,
		CaptureEpoch: input.Authority.CaptureEpoch, RenderInputHandle: uuid(input.Authority.RenderInputHandle), EnvelopeDigest: input.Authority.EnvelopeDigest,
		KeyHandle: uuid(input.Authority.KeyHandle), ObjectHandle: uuid(input.Authority.ObjectHandle),
	})
	if err != nil {
		return recordingrender.CommitResult{}, err
	}
	if !bytes.Equal(row.CommitDigest, input.CommitDigest) || !bytes.Equal(row.PresentationSha256, input.PresentationSHA256) || row.DurationMillis != input.DurationMillis || id(row.VideoAllocationID) != input.Video.AllocationID || !bytes.Equal(row.FfprobeFactsDigest, input.FFprobeFactsDigest) {
		return recordingrender.CommitResult{}, recordingrender.ErrCommitConflict
	}
	result := recordingrender.CommitResult{Artifact: recordingpipeline.Artifact{
		RecordingID: id(row.RecordingID), TenantID: id(row.TenantID), RenderJobID: id(row.RenderJobID), ObjectKey: row.ObjectKey,
		ContentType: row.ContentType, ByteSize: row.ByteSize, Checksum: append([]byte(nil), row.Checksum...),
		Duration: time.Duration(row.ArtifactDurationMillis) * time.Millisecond, CommittedAt: timestamp(row.ArtifactCommittedAt), CreatedAt: timestamp(row.ArtifactCreatedAt),
	}}
	if row.TranscriptionSourceID.Valid {
		result.Transcription = &recordingrender.TranscriptionResult{SourceID: id(row.TranscriptionSourceID), JobIDs: ids(row.TranscriptionJobIds)}
	}
	return result, nil
}

func mapCompletedRenderArtifact(row sqlc.CompleteRecordingRenderRow) recordingpipeline.Artifact {
	return recordingpipeline.Artifact{
		RecordingID: id(row.RecordingID), TenantID: id(row.TenantID), RenderJobID: id(row.RenderJobID), ObjectKey: row.ObjectKey,
		ContentType: row.ContentType, ByteSize: row.ByteSize, Checksum: append([]byte(nil), row.Checksum...),
		Duration: time.Duration(row.DurationMillis) * time.Millisecond, CommittedAt: timestamp(row.CommittedAt), CreatedAt: timestamp(row.CreatedAt),
	}
}

func renderOptionalInt8(value *int64) pgtype.Int8 {
	if value == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *value, Valid: true}
}

func renderNullableInt64(value pgtype.Int8) *int64 {
	if !value.Valid {
		return nil
	}
	result := value.Int64
	return &result
}

func cloneRenderInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}

func equalRenderInt64(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func ids(values []pgtype.UUID) []utilities.ID {
	result := make([]utilities.ID, 0, len(values))
	for _, value := range values {
		if value.Valid {
			result = append(result, id(value))
		}
	}
	return result
}

var _ recordingrender.Repository = RecordingRenderRepository{}
