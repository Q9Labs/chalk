package recorderworker

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
	"path/filepath"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (attempt *ProductionRenderAttempt) validateResolvedInput(input recordingrender.ResolvedInput) error {
	if input.TranscriptionMode.Validate() != nil {
		return fmt.Errorf("%w: missing or invalid transcription policy", ErrInvalidProductionRenderAttempt)
	}
	envelope := attempt.claim.Envelope
	presentationSHA, err := hex.DecodeString(envelope.PresentationSHA256)
	readyAt, readyErr := time.Parse(time.RFC3339Nano, *envelope.CaptureReadyAt)
	if err != nil || readyErr != nil || input.SchemaVersion != recordingrender.InputSchemaVersion ||
		input.TenantID.String() != envelope.TenantID || input.SpaceID.String() != envelope.SpaceID || input.EpisodeID.String() != envelope.EpisodeID || input.RecordingID.String() != envelope.RecordingID ||
		input.CaptureEpoch != envelope.CaptureEpoch || input.PresentationHandle.String() != envelope.PresentationHandle || input.PresentationSchemaVersion != envelope.PresentationSchemaVersion ||
		input.PresentationProfileVersion != envelope.PresentationProfileVersion || !bytes.Equal(input.PresentationSHA256, presentationSHA) ||
		input.DurationMillis != envelope.PresentationDurationMillis || !input.CaptureReadyAt.Equal(readyAt) || len(input.Capture) == 0 {
		return fmt.Errorf("%w: resolved recording render input does not match its claim", ErrInvalidProductionRenderAttempt)
	}
	return nil
}

func (attempt *ProductionRenderAttempt) validateTimeline(input recordingrender.ResolvedInput, timeline recordingpresentation.Timeline) error {
	viewport := timeline.Initial.Profile.Viewport
	validViewport := (viewport.Width == 1280 && viewport.Height == 720) || (viewport.Width == 1920 && viewport.Height == 1080)
	if timeline.SchemaVersion != input.PresentationSchemaVersion || timeline.RecordingID != input.RecordingID.String() || timeline.EpisodeID != input.EpisodeID.String() ||
		timeline.Clock.CaptureEpoch != input.CaptureEpoch || timeline.Clock.DurationMillis != input.DurationMillis || timeline.Clock.Origin != "capture_ready" || timeline.Clock.Timebase != "recording_relative_ms" ||
		timeline.Initial.Profile.Version != input.PresentationProfileVersion || !validViewport || viewport.DeviceScaleFactor != 1 {
		return fmt.Errorf("%w: recording presentation does not match render authority or profile", ErrInvalidProductionRenderAttempt)
	}
	return nil
}

func (attempt *ProductionRenderAttempt) stageAssets(ctx context.Context, downloads *renderInputDownloader, input recordingrender.ResolvedInput, timeline recordingpresentation.Timeline, manifestPath, assetDirectory string) error {
	encoded, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read recording asset manifest: %w", err)
	}
	var manifest recordingpresentation.AssetManifest
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return fmt.Errorf("decode recording asset manifest: %w", err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: recording asset manifest has trailing data", ErrInvalidProductionRenderAttempt)
	}
	if manifest.SchemaVersion != recordingpresentation.AssetManifestSchemaVersion || manifest.PresentationHandle != input.PresentationHandle.String() || len(manifest.Assets) != len(timeline.Assets) || len(input.Assets) != len(timeline.Assets) {
		return fmt.Errorf("%w: recording asset manifest authority mismatch", ErrInvalidProductionRenderAttempt)
	}
	for index, timelineAsset := range timeline.Assets {
		entry, object := manifest.Assets[index], input.Assets[index]
		if entry.Ordinal != index || entry.ID != timelineAsset.ID || entry.Kind != timelineAsset.Kind || entry.ObjectKey != timelineAsset.ObjectKey || entry.ObjectVersion != object.ObjectVersion || entry.ObjectETag != object.ObjectETag || entry.ContentType != timelineAsset.ContentType || entry.ByteSize != timelineAsset.ByteSize || entry.SHA256 != timelineAsset.SHA256 ||
			entry.ObjectKey != object.ObjectKey || entry.ContentType != object.ContentType || entry.ByteSize != object.ByteSize || entry.SHA256 != hex.EncodeToString(object.SHA256) {
			return fmt.Errorf("%w: recording asset manifest entry %d mismatch", ErrInvalidProductionRenderAttempt, index)
		}
		assetPath := filepath.Join(assetDirectory, timelineAsset.SHA256)
		if err := downloads.download(ctx, object, assetPath); err != nil {
			return fmt.Errorf("download recording asset %d: %w", index, err)
		}
	}
	return nil
}

func (attempt *ProductionRenderAttempt) downloadCapture(ctx context.Context, downloads *renderInputDownloader, input recordingrender.ResolvedInput, directory string) ([]recordingdecode.BundleFile, int64, error) {
	capture := append([]recordingrender.DownloadableCaptureObject(nil), input.Capture...)
	sort.Slice(capture, func(i, j int) bool { return capture[i].SequenceNumber < capture[j].SequenceNumber })
	bundles := make([]recordingdecode.BundleFile, 0, len(capture))
	var total int64
	for index, object := range capture {
		// Reservations allocate zero-based numbers before upload; uncommitted
		// reservations can leave holes in the authoritative committed sequence.
		if object.SequenceNumber < 0 || (index > 0 && object.SequenceNumber <= capture[index-1].SequenceNumber) || object.ByteSize < 0 || total > recordingdecode.MaximumInputBytes-object.ByteSize {
			return nil, 0, fmt.Errorf("%w: recording capture sequence or byte bound", ErrInvalidProductionRenderAttempt)
		}
		path := filepath.Join(directory, fmt.Sprintf("%08d.bundle", object.SequenceNumber))
		downloadable := recordingrender.DownloadableObject{ObjectFacts: object.ObjectFacts, Download: object.Download}
		if err := downloads.download(ctx, downloadable, path); err != nil {
			return nil, 0, fmt.Errorf("download recording capture sequence %d: %w", object.SequenceNumber, err)
		}
		total += object.ByteSize
		bundles = append(bundles, recordingdecode.BundleFile{
			Path: path, ExpectedSHA256: hex.EncodeToString(object.SHA256), Sequence: uint64(object.SequenceNumber),
			CaptureEpoch: object.CaptureEpoch, CaptureJobID: object.CaptureJobID.String(), RecorderEnvelopeDigest: hex.EncodeToString(object.EnvelopeDigest),
			BundleSchema: object.BundleSchema, KeyHandle: object.KeyHandle.String(),
		})
	}
	return bundles, total, nil
}

func (attempt *ProductionRenderAttempt) accessCaptureKeys(ctx context.Context, capture []recordingrender.DownloadableCaptureObject) ([]recordingdecode.DataKey, error) {
	type captureKeyAuthority struct {
		keyHandle      utilities.ID
		captureJobID   utilities.ID
		envelopeDigest string
	}
	epochAuthorities := make(map[int64]captureKeyAuthority)
	for _, object := range capture {
		authority := captureKeyAuthority{keyHandle: object.KeyHandle, captureJobID: object.CaptureJobID, envelopeDigest: string(object.EnvelopeDigest)}
		if object.CaptureEpoch <= 0 || authority.keyHandle.IsZero() || authority.captureJobID.IsZero() || len(object.EnvelopeDigest) != sha256.Size {
			return nil, fmt.Errorf("%w: recording capture key authority", ErrInvalidProductionRenderAttempt)
		}
		if existing, ok := epochAuthorities[object.CaptureEpoch]; ok && existing != authority {
			return nil, fmt.Errorf("%w: recording capture epoch authority changed", ErrInvalidProductionRenderAttempt)
		}
		epochAuthorities[object.CaptureEpoch] = authority
	}
	epochs := make([]int64, 0, len(epochAuthorities))
	for epoch := range epochAuthorities {
		epochs = append(epochs, epoch)
	}
	sort.Slice(epochs, func(i, j int) bool { return epochs[i] < epochs[j] })
	keys := make([]recordingdecode.DataKey, 0, len(epochs))
	for _, epoch := range epochs {
		key, err := withRenderAuthority(attempt, func(authority recordingrender.Authority) (recordingrender.DataKey, error) {
			return attempt.config.Control.AccessRenderKey(ctx, recordingrender.AccessKeyInput{Authority: authority, CaptureEpoch: epoch})
		})
		if err != nil {
			clearDecodeDataKeys(keys)
			return nil, fmt.Errorf("access recording capture epoch %d key: %w", epoch, err)
		}
		if key.CaptureEpoch != epoch || key.KeyHandle != epochAuthorities[epoch].keyHandle || len(key.Plaintext) != 32 {
			clear(key.Plaintext)
			clearDecodeDataKeys(keys)
			return nil, fmt.Errorf("%w: recording capture epoch %d key mismatch", ErrInvalidProductionRenderAttempt, epoch)
		}
		keys = append(keys, recordingdecode.DataKey{CaptureEpoch: epoch, Plaintext: key.Plaintext})
	}
	return keys, nil
}

func clearDecodeDataKeys(keys []recordingdecode.DataKey) {
	for index := range keys {
		clear(keys[index].Plaintext)
		keys[index].Plaintext = nil
	}
}
