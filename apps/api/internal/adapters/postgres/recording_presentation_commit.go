package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func insertPreparedRecordingPresentation(ctx context.Context, queries recordingPipelineQuerier, prepared recordingpresentation.PreparedPresentation) error {
	if err := validatePreparedRecordingPresentation(prepared); err != nil {
		return err
	}
	inserted, err := queries.InsertRecordingPresentation(ctx, sqlc.InsertRecordingPresentationParams{
		PresentationHandle: uuid(prepared.PresentationHandle), TenantID: uuid(prepared.TenantID),
		SpaceID: uuid(prepared.SpaceID), EpisodeID: uuid(prepared.EpisodeID), RecordingID: uuid(prepared.RecordingID),
		CaptureEpoch: prepared.CaptureEpoch, SchemaVersion: prepared.SchemaVersion,
		ProfileVersion: prepared.ProfileVersion, DurationMillis: prepared.DurationMillis,
		PresentationSha256:         prepared.PresentationSHA256,
		PresentationObjectKey:      prepared.PresentationObject.Key,
		PresentationObjectVersion:  prepared.PresentationObject.Version,
		PresentationObjectEtag:     prepared.PresentationObject.ETag,
		PresentationContentType:    prepared.PresentationObject.ContentType,
		PresentationByteSize:       prepared.PresentationObject.ByteSize,
		AssetManifestObjectKey:     prepared.AssetManifestObject.Key,
		AssetManifestObjectVersion: prepared.AssetManifestObject.Version,
		AssetManifestObjectEtag:    prepared.AssetManifestObject.ETag,
		AssetManifestContentType:   prepared.AssetManifestObject.ContentType,
		AssetManifestByteSize:      prepared.AssetManifestObject.ByteSize,
		AssetManifestSha256:        prepared.AssetManifestObject.SHA256,
		FrozenAt:                   timestamptzValue(prepared.FrozenAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpresentation.ErrObjectFactsMismatch
	}
	if err != nil {
		return fmt.Errorf("insert recording presentation: %w", err)
	}
	if inserted.PresentationHandle.Bytes != prepared.PresentationHandle.Bytes() ||
		!bytes.Equal(inserted.PresentationSha256, prepared.PresentationSHA256) ||
		inserted.PresentationObjectKey != prepared.PresentationObject.Key ||
		inserted.AssetManifestObjectKey != prepared.AssetManifestObject.Key {
		return recordingpresentation.ErrObjectFactsMismatch
	}
	for _, asset := range prepared.Assets {
		insertedAsset, err := queries.InsertRecordingPresentationAsset(ctx, sqlc.InsertRecordingPresentationAssetParams{
			PresentationHandle: uuid(prepared.PresentationHandle), TenantID: uuid(prepared.TenantID),
			RecordingID: uuid(prepared.RecordingID), Ordinal: int16(asset.Ordinal),
			AssetID: asset.Asset.ID, AssetKind: asset.Asset.Kind,
			ObjectKey: asset.Object.Key, ObjectVersion: asset.Object.Version,
			ObjectEtag: asset.Object.ETag, ContentType: asset.Object.ContentType,
			ByteSize: asset.Object.ByteSize, Sha256: asset.Object.SHA256,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return recordingpresentation.ErrObjectFactsMismatch
		}
		if err != nil {
			return fmt.Errorf("insert recording presentation asset %q: %w", asset.Asset.ID, err)
		}
		if int(insertedAsset.Ordinal) != asset.Ordinal || insertedAsset.AssetID != asset.Asset.ID ||
			insertedAsset.ObjectKey != asset.Object.Key || !bytes.Equal(insertedAsset.Sha256, asset.Object.SHA256) {
			return recordingpresentation.ErrObjectFactsMismatch
		}
	}
	return nil
}

func validatePreparedRecordingPresentation(prepared recordingpresentation.PreparedPresentation) error {
	if prepared.PresentationHandle.IsZero() || prepared.TenantID.IsZero() || prepared.SpaceID.IsZero() ||
		prepared.EpisodeID.IsZero() || prepared.RecordingID.IsZero() || prepared.CaptureEpoch <= 0 ||
		prepared.SchemaVersion != recordingpresentation.SchemaVersion || strings.TrimSpace(prepared.ProfileVersion) == "" ||
		prepared.DurationMillis <= 0 || len(prepared.PresentationSHA256) != sha256.Size || prepared.FrozenAt.IsZero() ||
		len(prepared.Assets) > recordingpresentation.MaximumAssets ||
		!validPreparedObject(prepared.PresentationObject) || !validPreparedObject(prepared.AssetManifestObject) ||
		!bytes.Equal(prepared.PresentationSHA256, prepared.PresentationObject.SHA256) {
		return recordingpresentation.ErrObjectFactsMismatch
	}
	for index, asset := range prepared.Assets {
		if asset.Ordinal != index || asset.Asset.ID == "" || asset.Asset.Kind == "" ||
			!validPreparedObject(asset.Object) || asset.Asset.ObjectKey != asset.Object.Key ||
			asset.Asset.ByteSize != asset.Object.ByteSize ||
			!strings.EqualFold(asset.Asset.ContentType, asset.Object.ContentType) {
			return recordingpresentation.ErrObjectFactsMismatch
		}
	}
	return nil
}

func validPreparedObject(object recordingpresentation.ObjectFact) bool {
	return strings.TrimSpace(object.Key) != "" && len(object.Key) <= 1024 && len(object.Version) <= 1024 &&
		strings.TrimSpace(object.ETag) != "" && len(object.ETag) <= 512 &&
		strings.TrimSpace(object.ContentType) != "" && len(object.ContentType) <= 255 &&
		object.ByteSize > 0 && len(object.SHA256) == sha256.Size
}
