package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
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
	err := r.transaction(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadWrite}, func(tx pgx.Tx, queries sqlc.Querier) error {
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
			SourceExpiresAt:   timestamp(inputRow.SourceExpiresAt),
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

func (r RecordingRenderRepository) transaction(ctx context.Context, options pgx.TxOptions, work func(pgx.Tx, sqlc.Querier) error) error {
	tx, err := r.pool.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := work(tx, sqlc.New(tx)); err != nil {
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

func mapRenderCaptureObjects(rows []sqlc.ListRecordingRenderCaptureObjectsRow) ([]recordingrender.CaptureObject, error) {
	objects := make([]recordingrender.CaptureObject, 0, len(rows))
	for _, row := range rows {
		if !row.CaptureJobID.Valid || !row.KeyHandle.Valid {
			return nil, recordingrender.ErrInputIncomplete
		}
		envelope, err := recordingpipeline.DecodeRecorderJobEnvelope(row.EnvelopeBytes, row.EnvelopeDigest)
		if err != nil {
			return nil, fmt.Errorf("%w: decode signed capture envelope: %v", recordingrender.ErrInputIncomplete, err)
		}
		if envelope.Kind != recordingpipeline.JobKindCapture || envelope.JobID != id(row.CaptureJobID).String() ||
			envelope.KeyHandle != id(row.KeyHandle).String() || envelope.CaptureEpoch != row.CaptureEpoch {
			return nil, fmt.Errorf("%w: capture envelope does not match stored object authority", recordingrender.ErrInputIncomplete)
		}
		objects = append(objects, recordingrender.CaptureObject{
			ObjectFacts:  recordingrender.ObjectFacts{ObjectKey: row.ObjectKey, ObjectVersion: row.ObjectVersion.String, ObjectETag: row.ObjectEtag.String, ContentType: row.ContentType, ByteSize: row.ByteSize, SHA256: append([]byte(nil), row.Sha256...)},
			CaptureEpoch: row.CaptureEpoch, CaptureJobID: id(row.CaptureJobID), KeyHandle: id(row.KeyHandle), EnvelopeDigest: append([]byte(nil), row.EnvelopeDigest...), BundleSchema: envelope.BundleSchemaVersion,
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

var _ recordingrender.Repository = RecordingRenderRepository{}
