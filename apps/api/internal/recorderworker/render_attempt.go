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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	defaultRenderFPS = 30
	renderVideoName  = "recording.mp4"
)

var ErrInvalidProductionRenderAttempt = errors.New("invalid production recording render attempt")

// RenderAuthorityPort is the complete least-authority surface used by one
// production render attempt. Object bytes use the upload client carried by the
// implementation, never the recorder worker mTLS transport.
type RenderAuthorityPort interface {
	ResolveRenderInput(context.Context, recordingrender.Authority) (recordingrender.ResolvedInput, error)
	AccessRenderKey(context.Context, recordingrender.AccessKeyInput) (recordingrender.DataKey, error)
	DownloadRenderObject(context.Context, recordingrender.DownloadableObject, string) error
	ReserveRenderObject(context.Context, recordingrender.ReserveObjectInput) (recordingrender.ReservedObject, error)
	FinalizeRenderObject(context.Context, recordingrender.FinalizeObjectInput) (recordingrender.FinalizedObject, error)
	UploadRenderObject(context.Context, objectstorage.SignedURL, io.Reader, int64) error
	CommitRenderObject(context.Context, recordingrender.CommitObjectInput) (recordingrender.CommittedObject, error)
	CommitRender(context.Context, recordingrender.CommitInput) (recordingrender.CommitResult, error)
}

type RecordingDecodeWriter func(context.Context, recordingdecode.Request) (recordingdecode.Result, error)

type ProductionRenderAttemptConfig struct {
	Control       RenderAuthorityPort
	WorkRoot      string
	Environment   string
	UIBuildSHA256 string
	FFmpegPath    string
	Encoder       VideoEncoder
	Frames        FrameProducer
	Commands      CommandRunner
	Streaming     StreamingCommandRunner
	Decode        RecordingDecodeWriter
	Now           func() time.Time
}

type ProductionRenderAttemptFactory struct {
	config ProductionRenderAttemptConfig
}

func NewProductionRenderAttemptFactory(config ProductionRenderAttemptConfig) (*ProductionRenderAttemptFactory, error) {
	config.WorkRoot = filepath.Clean(config.WorkRoot)
	config.Environment = strings.TrimSpace(config.Environment)
	config.UIBuildSHA256 = strings.TrimSpace(config.UIBuildSHA256)
	config.FFmpegPath = strings.TrimSpace(config.FFmpegPath)
	if config.Decode == nil {
		config.Decode = recordingdecode.Write
	}
	if config.Now == nil {
		config.Now = func() time.Time { return time.Now().UTC() }
	}
	if config.Control == nil || config.Frames == nil || config.Commands == nil || config.Streaming == nil || !filepath.IsAbs(config.WorkRoot) || config.Environment == "" || !isLowerSHA256(config.UIBuildSHA256) {
		return nil, ErrInvalidProductionRenderAttempt
	}
	if _, _, err := recordingEncoderArgs(config.Encoder); err != nil {
		return nil, ErrInvalidProductionRenderAttempt
	}
	if info, err := os.Stat(config.WorkRoot); err != nil || !info.IsDir() {
		return nil, ErrInvalidProductionRenderAttempt
	}
	return &ProductionRenderAttemptFactory{config: config}, nil
}

func (factory *ProductionRenderAttemptFactory) NewRenderAttempt(_ context.Context, claim ClaimResult) (RenderAttempt, error) {
	if factory == nil {
		return nil, ErrInvalidProductionRenderAttempt
	}
	authority, err := renderAuthorityFromClaim(claim, factory.config.Now())
	if err != nil {
		return nil, err
	}
	workspace, err := os.MkdirTemp(factory.config.WorkRoot, "recording-render-"+authority.RecordingID.String()+"-")
	if err != nil {
		return nil, fmt.Errorf("create recording render workspace: %w", err)
	}
	if err := os.Chmod(workspace, 0o700); err != nil {
		_ = os.RemoveAll(workspace)
		return nil, fmt.Errorf("secure recording render workspace: %w", err)
	}
	return &ProductionRenderAttempt{config: factory.config, claim: claim, authority: authority, workspace: workspace}, nil
}

type ProductionRenderAttempt struct {
	config    ProductionRenderAttemptConfig
	claim     ClaimResult
	workspace string
	leaseGate sync.Mutex

	mu        sync.Mutex
	authority recordingrender.Authority
	run       bool
	committed bool
	closed    bool
}

func (attempt *ProductionRenderAttempt) RenewLease(renew RenderLeaseRenewal) (recordingpipeline.LeaseInput, error) {
	if attempt == nil || renew == nil {
		return recordingpipeline.LeaseInput{}, ErrInvalidProductionRenderAttempt
	}
	attempt.leaseGate.Lock()
	defer attempt.leaseGate.Unlock()
	attempt.mu.Lock()
	committed := attempt.committed
	closed := attempt.closed
	attempt.mu.Unlock()
	if committed {
		return recordingpipeline.LeaseInput{}, ErrRenderAttemptCommitted
	}
	if closed {
		return recordingpipeline.LeaseInput{}, ErrInvalidProductionRenderAttempt
	}
	lease, expiresAt, err := renew()
	if err != nil {
		return recordingpipeline.LeaseInput{}, err
	}
	if recordingpipeline.ValidateLeaseInput(lease) != nil || !expiresAt.After(attempt.config.Now().UTC()) {
		return recordingpipeline.LeaseInput{}, ErrInvalidProductionRenderAttempt
	}
	attempt.mu.Lock()
	defer attempt.mu.Unlock()
	if attempt.closed || lease.JobID != attempt.authority.JobID || lease.AttemptCount != attempt.authority.AttemptCount || lease.FencingGeneration != attempt.authority.FencingGeneration || lease.CaptureEpoch != attempt.authority.CaptureEpoch || lease.LeaseToken != attempt.authority.LeaseToken || lease.LeaseOwner != attempt.authority.LeaseOwner || !bytes.Equal(lease.EnvelopeDigest, attempt.authority.EnvelopeDigest) {
		return recordingpipeline.LeaseInput{}, ErrInvalidProductionRenderAttempt
	}
	attempt.authority.LeaseExpiresAt = expiresAt.UTC()
	return lease, nil
}

func (attempt *ProductionRenderAttempt) Close() error {
	if attempt == nil {
		return nil
	}
	attempt.mu.Lock()
	if attempt.closed {
		attempt.mu.Unlock()
		return nil
	}
	attempt.closed = true
	workspace := attempt.workspace
	attempt.mu.Unlock()
	return os.RemoveAll(workspace)
}

func (attempt *ProductionRenderAttempt) Run(ctx context.Context) error {
	if attempt == nil {
		return ErrInvalidProductionRenderAttempt
	}
	attempt.mu.Lock()
	if attempt.run || attempt.closed {
		attempt.mu.Unlock()
		return ErrInvalidProductionRenderAttempt
	}
	attempt.run = true
	attempt.mu.Unlock()

	deadline, err := time.Parse(time.RFC3339Nano, attempt.claim.Envelope.HardDeadline)
	if err != nil {
		return ErrInvalidProductionRenderAttempt
	}
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()

	resolved, err := withRenderAuthority(attempt, func(authority recordingrender.Authority) (recordingrender.ResolvedInput, error) {
		return attempt.config.Control.ResolveRenderInput(ctx, authority)
	})
	if err != nil {
		return fmt.Errorf("resolve recording render input: %w", err)
	}
	if err := attempt.validateResolvedInput(resolved); err != nil {
		return err
	}

	downloads, err := newRenderInputDownloader(attempt, resolved)
	if err != nil {
		return err
	}

	presentationPath := filepath.Join(attempt.workspace, "presentation.json")
	assetManifestPath := filepath.Join(attempt.workspace, "asset-manifest.json")
	bundleDirectory := filepath.Join(attempt.workspace, "bundles")
	assetDirectory := filepath.Join(attempt.workspace, "assets")
	if err := os.Mkdir(bundleDirectory, 0o700); err != nil {
		return fmt.Errorf("create recording bundle directory: %w", err)
	}
	if err := os.Mkdir(assetDirectory, 0o700); err != nil {
		return fmt.Errorf("create recording asset directory: %w", err)
	}
	if err := downloads.download(ctx, resolved.Presentation, presentationPath); err != nil {
		return fmt.Errorf("download recording presentation: %w", err)
	}
	if err := downloads.download(ctx, resolved.AssetManifest, assetManifestPath); err != nil {
		return fmt.Errorf("download recording asset manifest: %w", err)
	}
	presentationBytes, err := os.ReadFile(presentationPath)
	if err != nil {
		return fmt.Errorf("read recording presentation: %w", err)
	}
	timeline, err := recordingpresentation.Decode(presentationBytes)
	if err != nil {
		return fmt.Errorf("decode recording presentation: %w", err)
	}
	if err := attempt.validateTimeline(resolved, timeline); err != nil {
		return err
	}
	if err := attempt.stageAssets(ctx, downloads, resolved, timeline, assetManifestPath, assetDirectory); err != nil {
		return err
	}
	bundles, inputBytes, err := attempt.downloadCapture(ctx, downloads, resolved, bundleDirectory)
	if err != nil {
		return err
	}

	dataKeys, err := attempt.accessCaptureKeys(ctx, resolved.Capture)
	if err != nil {
		return err
	}
	defer clearDecodeDataKeys(dataKeys)
	decodedDirectory := filepath.Join(attempt.workspace, "decoded")
	decoded, err := attempt.config.Decode(ctx, recordingdecode.Request{
		RecordingID: timeline.RecordingID, EpisodeID: timeline.EpisodeID, TenantID: resolved.TenantID.String(),
		Environment: attempt.config.Environment, OriginAuthorityID: timeline.Clock.OriginAuthorityID,
		CaptureEpoch: resolved.CaptureEpoch, DurationMS: resolved.DurationMillis, OutputDirectory: decodedDirectory,
		FFmpegPath: attempt.config.FFmpegPath, Presentation: timeline, Bundles: bundles, DataKeys: dataKeys,
	})
	clearDecodeDataKeys(dataKeys)
	if err != nil {
		return fmt.Errorf("decode authenticated recording media: %w", err)
	}

	videoPath := filepath.Join(attempt.workspace, renderVideoName)
	frameRequest := FrameRenderRequest{
		SchemaVersion: FrameRenderRequestVersion, RecordingID: resolved.RecordingID.String(), EpisodeID: resolved.EpisodeID.String(),
		WorkspaceDirectory: attempt.workspace, PresentationPath: presentationPath, PresentationSHA256: hex.EncodeToString(resolved.PresentationSHA256),
		UIBuildSHA256: attempt.config.UIBuildSHA256, AssetDirectory: assetDirectory, DecodedMediaPath: decoded.IndexPath,
		DecodedMediaSHA256: decoded.IndexSHA256, Width: timeline.Initial.Profile.Viewport.Width, Height: timeline.Initial.Profile.Viewport.Height,
		FPS: defaultRenderFPS, DurationMs: resolved.DurationMillis,
	}
	mixPath := filepath.Join(decodedDirectory, filepath.FromSlash(decoded.Index.Mix.Path))
	encodePlan, err := BuildRecordingEncodePlan(mixPath, videoPath, RecordingEncodeConfig{
		Width: frameRequest.Width, Height: frameRequest.Height, FPS: frameRequest.FPS, DurationMs: frameRequest.DurationMs, Encoder: attempt.config.Encoder,
	})
	if err != nil {
		return fmt.Errorf("build recording encode plan: %w", err)
	}
	rendered, err := RenderFrameStream(ctx, attempt.config.Frames, attempt.config.Streaming, frameRequest, encodePlan)
	if err != nil {
		return fmt.Errorf("render recording frame stream: %w", err)
	}
	mediaFacts, err := VerifyRecordingMedia(ctx, attempt.config.Commands, videoPath, RecordingMediaExpectation{
		Width: encodePlan.Width, Height: encodePlan.Height, FPS: encodePlan.FPS, FrameCount: encodePlan.FrameCount, DurationMs: encodePlan.OutputDuration,
	})
	if err != nil {
		return fmt.Errorf("verify encoded recording: %w", err)
	}
	_ = rendered
	factsBytes, err := json.Marshal(mediaFacts)
	if err != nil {
		return fmt.Errorf("encode recording media facts: %w", err)
	}
	factsDigest := sha256.Sum256(factsBytes)
	videoDuration := resolved.DurationMillis
	video, err := attempt.persistFile(ctx, recordingrender.PurposeRecordingVideo, "video", videoPath, &videoDuration)
	if err != nil {
		return err
	}

	transcription, err := attempt.persistTranscription(ctx, resolved, timeline, decodedDirectory, decoded.Index)
	if err != nil {
		return err
	}
	commit := recordingrender.CommitInput{
		PresentationSHA256: append([]byte(nil), resolved.PresentationSHA256...),
		DurationMillis:     resolved.DurationMillis, Video: video, FFprobeFactsDigest: append([]byte(nil), factsDigest[:]...), TranscriptionSource: transcription,
	}
	if _, err := withRenderAuthority(attempt, func(authority recordingrender.Authority) (recordingrender.CommitResult, error) {
		commit.Authority = authority
		digest, digestErr := recordingrender.CommitDigest(commit)
		if digestErr != nil {
			return recordingrender.CommitResult{}, fmt.Errorf("digest recording render commit: %w", digestErr)
		}
		commit.CommitDigest = digest
		result, commitErr := attempt.config.Control.CommitRender(ctx, commit)
		if commitErr == nil {
			attempt.mu.Lock()
			attempt.committed = true
			attempt.mu.Unlock()
		}
		return result, commitErr
	}); err != nil {
		return fmt.Errorf("commit recording Artifact: %w", err)
	}
	_ = inputBytes
	return nil
}

func (attempt *ProductionRenderAttempt) currentAuthority() recordingrender.Authority {
	attempt.mu.Lock()
	defer attempt.mu.Unlock()
	authority := attempt.authority
	authority.EnvelopeDigest = append([]byte(nil), authority.EnvelopeDigest...)
	return authority
}

func withRenderAuthority[T any](attempt *ProductionRenderAttempt, call func(recordingrender.Authority) (T, error)) (T, error) {
	attempt.leaseGate.Lock()
	defer attempt.leaseGate.Unlock()
	return call(attempt.currentAuthority())
}

func (attempt *ProductionRenderAttempt) validateResolvedInput(input recordingrender.ResolvedInput) error {
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
		timeline.Initial.Profile.Version != input.PresentationProfileVersion || timeline.Initial.Profile.UIBuildSHA256 != attempt.config.UIBuildSHA256 || !validViewport || viewport.DeviceScaleFactor != 1 {
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

func (attempt *ProductionRenderAttempt) persistTranscription(ctx context.Context, input recordingrender.ResolvedInput, timeline recordingpresentation.Timeline, decodedRoot string, index recordingdecode.Index) (*recordingrender.TranscriptionSource, error) {
	authority := attempt.currentAuthority()
	sources := make([]recordingdecode.Source, 0)
	for _, source := range index.Sources {
		if source.Kind == "microphone" {
			sources = append(sources, source)
		}
	}
	if len(sources) == 0 {
		return nil, nil
	}
	sort.Slice(sources, func(i, j int) bool {
		if sources[i].StartMS != sources[j].StartMS {
			return sources[i].StartMS < sources[j].StartMS
		}
		return sources[i].SourceID < sources[j].SourceID
	})
	plannedChunks := int64(0)
	for _, source := range sources {
		plannedChunks += (source.EndMS - source.StartMS + TranscriptionChunkMaximumMillis - 1) / TranscriptionChunkMaximumMillis
		if plannedChunks > recordingrender.MaximumTranscriptionChunks {
			return nil, fmt.Errorf("%w: recording transcription chunk count exceeds bound", ErrInvalidProductionRenderAttempt)
		}
	}
	chunks := make([]recordingrender.TranscriptionChunk, 0)
	for _, source := range sources {
		for chunkStart := source.StartMS; chunkStart < source.EndMS; chunkStart += TranscriptionChunkMaximumMillis {
			chunkEnd := chunkStart + TranscriptionChunkMaximumMillis
			if chunkEnd > source.EndMS {
				chunkEnd = source.EndMS
			}
			indexValue := len(chunks)
			chunkPath := filepath.Join(attempt.workspace, fmt.Sprintf("transcription-%05d.flac", indexValue))
			sourceOffset := chunkStart - source.StartMS
			plan, err := BuildTranscriptionAudioPlan(filepath.Join(decodedRoot, filepath.FromSlash(source.Path)), chunkPath, sourceOffset, chunkEnd-chunkStart)
			if err != nil {
				return nil, fmt.Errorf("plan recording transcription chunk %d: %w", indexValue, err)
			}
			if _, err := RenderTranscriptionAudio(ctx, attempt.config.Commands, plan); err != nil {
				return nil, fmt.Errorf("render recording transcription chunk %d: %w", indexValue, err)
			}
			duration := chunkEnd - chunkStart
			object, err := attempt.persistFile(ctx, recordingrender.PurposeTranscriptionAudio, fmt.Sprintf("audio:%s:%d:%d", source.SourceID, chunkStart, chunkEnd), chunkPath, &duration)
			if err != nil {
				return nil, err
			}
			chunks = append(chunks, recordingrender.TranscriptionChunk{
				ChunkID: deterministicRenderID(authority, "chunk:"+source.SourceID+":"+strconv.FormatInt(chunkStart, 10)+":"+strconv.FormatInt(chunkEnd, 10)),
				Index:   indexValue, Generation: authority.FencingGeneration, StartMillis: chunkStart, EndMillis: chunkEnd,
				SourceStartMillis: sourceOffset, SourceEndMillis: sourceOffset + duration,
				ParticipantRef: source.ParticipantID, ParticipantGeneration: source.ParticipantGeneration,
				DisplayNameSnapshot: participantDisplayNameAt(timeline, source.ParticipantID, chunkStart), TrackID: source.TrackID,
				TrackEpoch: strconv.FormatInt(source.TrackEpoch, 10), IdentityKind: "participant", TrackClass: "microphone",
				Overlap: microphoneOverlap(sources, source.SourceID, chunkStart, chunkEnd), Object: object,
			})
		}
	}
	manifestBytes, manifestSHA, err := MarshalTranscriptionSourceManifest(attempt.currentAuthority(), input.PresentationSHA256, input.DurationMillis, chunks)
	if err != nil {
		return nil, fmt.Errorf("build recording transcription source: %w", err)
	}
	manifestPath := filepath.Join(attempt.workspace, "transcription-source.json")
	if err := os.WriteFile(manifestPath, manifestBytes, 0o600); err != nil {
		return nil, fmt.Errorf("write recording transcription source: %w", err)
	}
	manifest, err := attempt.persistFile(ctx, recordingrender.PurposeTranscriptionManifest, "transcription-manifest", manifestPath, nil)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(manifest.Object.SHA256, manifestSHA) {
		return nil, fmt.Errorf("%w: transcription source digest drift", ErrInvalidProductionRenderAttempt)
	}
	return &recordingrender.TranscriptionSource{SchemaVersion: recordingrender.TranscriptionSourceSchemaVersion, PresentationSHA256: append([]byte(nil), input.PresentationSHA256...), Manifest: manifest, Chunks: chunks}, nil
}

func (attempt *ProductionRenderAttempt) persistFile(ctx context.Context, purpose recordingrender.ObjectPurpose, stableName, path string, duration *int64) (recordingrender.CommitObjectReference, error) {
	info, err := os.Stat(path)
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("inspect recording render object %s: %w", purpose, err)
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("%w: recording render object %s is not a non-empty regular file", ErrInvalidProductionRenderAttempt, purpose)
	}
	file, err := os.Open(path)
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("open recording render object %s: %w", purpose, err)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		_ = file.Close()
		return recordingrender.CommitObjectReference{}, fmt.Errorf("hash recording render object %s: %w", purpose, err)
	}
	if err := file.Close(); err != nil {
		return recordingrender.CommitObjectReference{}, err
	}
	checksum := hash.Sum(nil)
	authority := attempt.currentAuthority()
	reserved, err := withRenderAuthority(attempt, func(current recordingrender.Authority) (recordingrender.ReservedObject, error) {
		return attempt.config.Control.ReserveRenderObject(ctx, recordingrender.ReserveObjectInput{
			Authority: current, Purpose: purpose, ReservationRequestID: deterministicRenderID(authority, "reserve:"+string(purpose)+":"+stableName),
		})
	})
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("reserve recording render object %s: %w", purpose, err)
	}
	contentType := map[recordingrender.ObjectPurpose]string{
		recordingrender.PurposeRecordingVideo: "video/mp4", recordingrender.PurposeTranscriptionAudio: "audio/flac", recordingrender.PurposeTranscriptionManifest: "application/json",
	}[purpose]
	finalized, err := withRenderAuthority(attempt, func(authority recordingrender.Authority) (recordingrender.FinalizedObject, error) {
		return attempt.config.Control.FinalizeRenderObject(ctx, recordingrender.FinalizeObjectInput{
			Authority: authority, AllocationID: reserved.AllocationID, Purpose: purpose, ContentType: contentType,
			ByteSize: info.Size(), SHA256: checksum, DurationMillis: duration,
		})
	})
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("finalize recording render object %s: %w", purpose, err)
	}
	if finalized.AllocationID != reserved.AllocationID || finalized.ObjectKey != reserved.ObjectKey || finalized.Purpose != purpose || finalized.AllocationVersion != reserved.AllocationVersion {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("%w: finalized recording render object changed its reservation", ErrInvalidProductionRenderAttempt)
	}
	file, err = os.Open(path)
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("reopen recording render object %s: %w", purpose, err)
	}
	uploadErr := attempt.config.Control.UploadRenderObject(ctx, finalized.Upload, file, info.Size())
	closeErr := file.Close()
	if err := errors.Join(uploadErr, closeErr); err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("upload recording render object %s: %w", purpose, err)
	}
	committed, err := withRenderAuthority(attempt, func(authority recordingrender.Authority) (recordingrender.CommittedObject, error) {
		return attempt.config.Control.CommitRenderObject(ctx, recordingrender.CommitObjectInput{Authority: authority, AllocationID: reserved.AllocationID, UploadToken: finalized.UploadToken})
	})
	if err != nil {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("commit recording render object %s: %w", purpose, err)
	}
	if committed.AllocationID != reserved.AllocationID || committed.Object.ObjectKey != reserved.ObjectKey || committed.Purpose != purpose || committed.AllocationVersion != reserved.AllocationVersion || committed.Object.ContentType != contentType || committed.Object.ByteSize != info.Size() || !bytes.Equal(committed.Object.SHA256, checksum) || !equalRenderDuration(committed.DurationMillis, duration) {
		return recordingrender.CommitObjectReference{}, fmt.Errorf("%w: committed recording render object facts changed", ErrInvalidProductionRenderAttempt)
	}
	return recordingrender.CommitObjectReference{AllocationID: committed.AllocationID, Purpose: purpose, Object: committed.Object, DurationMillis: committed.DurationMillis}, nil
}

func renderAuthorityFromClaim(claim ClaimResult, now time.Time) (recordingrender.Authority, error) {
	envelope := claim.Envelope
	tenantID, e1 := utilities.ParseID(envelope.TenantID)
	spaceID, e2 := utilities.ParseID(envelope.SpaceID)
	episodeID, e3 := utilities.ParseID(envelope.EpisodeID)
	recordingID, e4 := utilities.ParseID(envelope.RecordingID)
	jobID, e5 := utilities.ParseID(envelope.JobID)
	renderInputHandle, e6 := utilities.ParseID(envelope.RenderInputHandle)
	keyHandle, e7 := utilities.ParseID(envelope.KeyHandle)
	objectHandle, e8 := utilities.ParseID(envelope.ObjectHandle)
	_, e9 := utilities.ParseID(envelope.PresentationHandle)
	presentationSHA, e10 := hex.DecodeString(envelope.PresentationSHA256)
	var e11 error
	if envelope.CaptureReadyAt == nil {
		e11 = errors.New("capture ready time is absent")
	} else {
		_, e11 = time.Parse(time.RFC3339Nano, *envelope.CaptureReadyAt)
	}
	deadline, e12 := time.Parse(time.RFC3339Nano, envelope.HardDeadline)
	if !deadline.After(now.UTC()) || errors.Join(e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12) != nil || len(presentationSHA) != sha256.Size || envelope.PresentationSHA256 != strings.ToLower(envelope.PresentationSHA256) || envelope.Kind != recordingpipeline.JobKindRender || claim.ClaimRequestID.IsZero() || len(claim.EnvelopeDigest) != sha256.Size || strings.TrimSpace(claim.LeaseToken) == "" || strings.TrimSpace(claim.LeaseOwner) == "" || !claim.LeaseExpiresAt.After(now.UTC()) {
		return recordingrender.Authority{}, ErrInvalidProductionRenderAttempt
	}
	authority := recordingrender.Authority{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		RenderInputHandle: renderInputHandle, KeyHandle: keyHandle, ObjectHandle: objectHandle,
		AttemptCount: envelope.AttemptCount, FencingGeneration: envelope.FencingGeneration, CaptureEpoch: envelope.CaptureEpoch,
		EnvelopeDigest: append([]byte(nil), claim.EnvelopeDigest...), LeaseToken: claim.LeaseToken, LeaseOwner: claim.LeaseOwner, LeaseExpiresAt: claim.LeaseExpiresAt,
	}
	if err := authority.Validate(); err != nil || envelope.PresentationHandle == "" || envelope.PresentationSHA256 == "" || envelope.CaptureReadyAt == nil {
		return recordingrender.Authority{}, ErrInvalidProductionRenderAttempt
	}
	return authority, nil
}

func equalRenderDuration(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func deterministicRenderID(authority recordingrender.Authority, name string) utilities.ID {
	hash := sha256.New()
	_, _ = hash.Write([]byte("chalk.recording.render.id.v1\x00"))
	_, _ = hash.Write([]byte(authority.RecordingID.String()))
	_, _ = hash.Write([]byte{'\x00'})
	_, _ = hash.Write([]byte(authority.JobID.String()))
	_, _ = hash.Write([]byte{'\x00'})
	_, _ = hash.Write([]byte(strconv.FormatInt(authority.FencingGeneration, 10)))
	_, _ = hash.Write([]byte{'\x00'})
	_, _ = hash.Write([]byte(name))
	sum := hash.Sum(nil)
	var value [16]byte
	copy(value[:], sum)
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	clear(sum)
	return utilities.IDFromBytes(value)
}

func participantDisplayNameAt(timeline recordingpresentation.Timeline, participantID string, atMillis int64) string {
	names := make(map[string]string, len(timeline.Initial.Participants))
	for _, participant := range timeline.Initial.Participants {
		names[participant.ID] = participant.DisplayName
	}
	for _, event := range timeline.Events {
		switch value := event.(type) {
		case recordingpresentation.ParticipantJoinedEvent:
			if value.AtMillis <= atMillis {
				names[value.Participant.ID] = value.Participant.DisplayName
			}
		case *recordingpresentation.ParticipantJoinedEvent:
			if value != nil && value.AtMillis <= atMillis {
				names[value.Participant.ID] = value.Participant.DisplayName
			}
		case recordingpresentation.ParticipantDisplayNameChangedEvent:
			if value.AtMillis <= atMillis {
				names[value.ParticipantID] = value.DisplayName
			}
		case *recordingpresentation.ParticipantDisplayNameChangedEvent:
			if value != nil && value.AtMillis <= atMillis {
				names[value.ParticipantID] = value.DisplayName
			}
		}
	}
	return names[participantID]
}

func microphoneOverlap(sources []recordingdecode.Source, currentID string, start, end int64) bool {
	for _, source := range sources {
		if source.SourceID != currentID && source.StartMS < end && source.EndMS > start {
			return true
		}
	}
	return false
}
