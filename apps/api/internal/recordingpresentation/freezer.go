package recordingpresentation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

type presentationObjectStore interface {
	PutObject(context.Context, objectstorage.PutObjectInput) (objectstorage.Object, error)
	GetObject(context.Context, string) (objectstorage.ObjectReader, error)
}

type Freezer struct {
	sources CompletionSourceReader
	objects presentationObjectStore
	now     func() time.Time
}

func NewFreezer(sources CompletionSourceReader, objects presentationObjectStore) (Freezer, error) {
	if sources == nil || objects == nil {
		return Freezer{}, ErrInvalidCompletionSource
	}
	return Freezer{sources: sources, objects: objects, now: time.Now}, nil
}

func (freezer Freezer) Prepare(ctx context.Context, authority CompletionAuthority) (PreparedPresentation, error) {
	if err := authority.Validate(); err != nil {
		return PreparedPresentation{}, err
	}
	if freezer.sources == nil || freezer.objects == nil || freezer.now == nil {
		return PreparedPresentation{}, ErrInvalidCompletionSource
	}
	source, err := freezer.sources.LoadCompletionSource(ctx, authority)
	if err != nil {
		return PreparedPresentation{}, err
	}
	if source.CaptureEpoch != authority.CaptureEpoch {
		return PreparedPresentation{}, ErrInvalidCompletionSource
	}
	built, err := buildPresentation(source)
	if err != nil {
		return PreparedPresentation{}, err
	}

	assets := make([]PreparedAsset, 0, len(built.Assets))
	for ordinal, material := range built.Assets {
		var facts ObjectFact
		if material.Existing != nil {
			facts, err = freezer.copyExistingCanonical(ctx, source, material.Asset.ObjectKey, *material.Existing)
		} else {
			facts, err = freezer.putCanonical(ctx, source, material.Asset.ObjectKey, material.Asset.ContentType, material.Body)
		}
		if err != nil {
			return PreparedPresentation{}, fmt.Errorf("prepare recording presentation asset %q: %w", material.Asset.ID, err)
		}
		if !timelineAssetMatchesObject(material.Asset, facts) {
			return PreparedPresentation{}, ErrObjectFactsMismatch
		}
		assets = append(assets, PreparedAsset{Ordinal: ordinal, Asset: material.Asset, Object: facts})
	}

	timelineBytes, err := built.Timeline.CanonicalBytes()
	if err != nil {
		return PreparedPresentation{}, err
	}
	timelineDigest := sha256.Sum256(timelineBytes)
	timelineKey := presentationObjectPrefix(source) + "/timeline-" + hex.EncodeToString(timelineDigest[:]) + ".json"
	timelineObject, err := freezer.putCanonical(ctx, source, timelineKey, "application/json", timelineBytes)
	if err != nil {
		return PreparedPresentation{}, fmt.Errorf("store recording presentation timeline: %w", err)
	}

	manifest := AssetManifest{
		SchemaVersion: AssetManifestSchemaVersion, PresentationHandle: source.PresentationHandle.String(),
		Assets: make([]AssetManifestEntry, 0, len(assets)),
	}
	for _, asset := range assets {
		manifest.Assets = append(manifest.Assets, AssetManifestEntry{
			Ordinal: asset.Ordinal, ID: asset.Asset.ID, Kind: asset.Asset.Kind,
			ObjectKey: asset.Object.Key, ObjectVersion: asset.Object.Version,
			ObjectETag: asset.Object.ETag, ContentType: asset.Object.ContentType,
			ByteSize: asset.Object.ByteSize, SHA256: hex.EncodeToString(asset.Object.SHA256),
		})
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return PreparedPresentation{}, fmt.Errorf("encode recording presentation asset manifest: %w", err)
	}
	manifestDigest := sha256.Sum256(manifestBytes)
	manifestKey := presentationObjectPrefix(source) + "/assets-" + hex.EncodeToString(manifestDigest[:]) + ".json"
	manifestObject, err := freezer.putCanonical(ctx, source, manifestKey, "application/json", manifestBytes)
	if err != nil {
		return PreparedPresentation{}, fmt.Errorf("store recording presentation asset manifest: %w", err)
	}

	return PreparedPresentation{
		PresentationHandle: source.PresentationHandle,
		TenantID:           source.TenantID, SpaceID: source.SpaceID, EpisodeID: source.EpisodeID,
		RecordingID: source.RecordingID, CaptureEpoch: source.CaptureEpoch,
		SchemaVersion: SchemaVersion, ProfileVersion: source.Profile.Version,
		DurationMillis:     source.DurationMillis,
		PresentationSHA256: append([]byte(nil), timelineDigest[:]...),
		PresentationObject: timelineObject, AssetManifestObject: manifestObject,
		Assets: assets, FrozenAt: freezer.now().UTC(),
	}, nil
}

func (freezer Freezer) copyExistingCanonical(
	ctx context.Context,
	source CompletionSource,
	destinationKey string,
	expected ObjectFact,
) (ObjectFact, error) {
	if err := validateObjectFact(expected, true); err != nil {
		return ObjectFact{}, err
	}
	if strings.TrimSpace(destinationKey) == "" || destinationKey == expected.Key {
		return ObjectFact{}, ErrObjectFactsMismatch
	}

	// A previous Prepare may have frozen the bytes before its database commit
	// lost authority. Prefer that recording-owned copy so a retry does not
	// depend on the shorter-lived chat or whiteboard source object.
	frozenExpected := expected
	frozenExpected.Key = destinationKey
	frozenExpected.Version = ""
	frozenExpected.ETag = ""
	frozen, err := freezer.verifyObject(ctx, frozenExpected, false, nil)
	if err == nil {
		return frozen, nil
	}
	if !errors.Is(err, objectstorage.ErrObjectNotFound) {
		return ObjectFact{}, err
	}

	temporary, err := os.CreateTemp("", "chalk-recording-presentation-asset-*")
	if err != nil {
		return ObjectFact{}, err
	}
	temporaryName := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
	}()
	if _, err := freezer.verifyObject(ctx, expected, true, temporary); err != nil {
		return ObjectFact{}, err
	}
	if _, err := temporary.Seek(0, io.SeekStart); err != nil {
		return ObjectFact{}, err
	}
	return freezer.putCanonicalReader(
		ctx, source, destinationKey, expected.ContentType, expected.ByteSize, expected.SHA256, temporary,
	)
}

func (freezer Freezer) verifyObject(
	ctx context.Context,
	expected ObjectFact,
	requireIdentity bool,
	destination io.Writer,
) (ObjectFact, error) {
	if err := validateObjectFact(expected, requireIdentity); err != nil {
		return ObjectFact{}, err
	}
	object, err := freezer.objects.GetObject(ctx, expected.Key)
	if err != nil {
		return ObjectFact{}, err
	}
	if object.Body == nil || object.Key != expected.Key || object.Size != expected.ByteSize ||
		!strings.EqualFold(object.ContentType, expected.ContentType) || strings.TrimSpace(object.ETag) == "" ||
		(requireIdentity && (object.ETag != expected.ETag || (expected.Version != "" && object.VersionID != expected.Version))) {
		if object.Body != nil {
			_ = object.Body.Close()
		}
		return ObjectFact{}, ErrObjectFactsMismatch
	}
	hasher := sha256.New()
	writer := io.Writer(hasher)
	if destination != nil {
		writer = io.MultiWriter(destination, hasher)
	}
	readSize, readErr := io.Copy(writer, io.LimitReader(object.Body, expected.ByteSize+1))
	closeErr := object.Body.Close()
	if readErr != nil {
		return ObjectFact{}, readErr
	}
	if closeErr != nil {
		return ObjectFact{}, closeErr
	}
	digest := hasher.Sum(nil)
	if readSize != expected.ByteSize || !bytes.Equal(digest, expected.SHA256) {
		return ObjectFact{}, ErrObjectFactsMismatch
	}
	return ObjectFact{
		Key: object.Key, Version: object.VersionID, ETag: object.ETag,
		ContentType: expected.ContentType, ByteSize: object.Size,
		SHA256: append([]byte(nil), digest...),
	}, nil
}

func (freezer Freezer) putCanonical(ctx context.Context, source CompletionSource, key, contentType string, body []byte) (ObjectFact, error) {
	if len(body) == 0 {
		return ObjectFact{}, ErrObjectFactsMismatch
	}
	digest := sha256.Sum256(body)
	return freezer.putCanonicalReader(ctx, source, key, contentType, int64(len(body)), digest[:], bytes.NewReader(body))
}

func (freezer Freezer) putCanonicalReader(
	ctx context.Context,
	source CompletionSource,
	key string,
	contentType string,
	byteSize int64,
	digest []byte,
	body io.Reader,
) (ObjectFact, error) {
	if body == nil || !positiveSafe(byteSize) || len(digest) != sha256.Size {
		return ObjectFact{}, ErrObjectFactsMismatch
	}
	stored, err := freezer.objects.PutObject(ctx, objectstorage.PutObjectInput{
		Key: key, Body: body, ContentType: contentType,
		ContentLength: byteSize, CacheControl: "private, max-age=31536000, immutable",
		Metadata: map[string]string{
			"chalk-recording-id":        source.RecordingID.String(),
			"chalk-presentation-handle": source.PresentationHandle.String(),
			"chalk-sha256":              hex.EncodeToString(digest),
		},
		IfNoneMatch: true,
	})
	if err != nil && !errors.Is(err, objectstorage.ErrObjectAlreadyExists) {
		return ObjectFact{}, err
	}
	verified, verifyErr := freezer.verifyObject(ctx, ObjectFact{
		Key: key, ContentType: contentType, ByteSize: byteSize, SHA256: digest,
	}, false, nil)
	if verifyErr != nil {
		return ObjectFact{}, verifyErr
	}
	if err == nil && (stored.Key != verified.Key || stored.Size != verified.ByteSize ||
		stored.ETag != verified.ETag || (stored.VersionID != "" && verified.Version != "" && stored.VersionID != verified.Version)) {
		return ObjectFact{}, ErrObjectFactsMismatch
	}
	return verified, nil
}

func validateObjectFact(fact ObjectFact, requireETag bool) error {
	if strings.TrimSpace(fact.Key) == "" || len(fact.Key) > 1024 || len(fact.Version) > 1024 ||
		strings.TrimSpace(fact.ContentType) == "" || len(fact.ContentType) > 255 ||
		!positiveSafe(fact.ByteSize) || len(fact.SHA256) != sha256.Size ||
		(requireETag && strings.TrimSpace(fact.ETag) == "") || len(fact.ETag) > 512 {
		return ErrObjectFactsMismatch
	}
	return nil
}

func timelineAssetMatchesObject(asset Asset, object ObjectFact) bool {
	return asset.ObjectKey == object.Key && asset.ByteSize == object.ByteSize &&
		strings.EqualFold(asset.ContentType, object.ContentType) &&
		asset.SHA256 == hex.EncodeToString(object.SHA256)
}
