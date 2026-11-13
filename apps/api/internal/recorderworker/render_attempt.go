package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

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
	return attempt.measure(RenderAttemptStageCleanup, func() error {
		return os.RemoveAll(workspace)
	})
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
	if isTranscriptionRenderJob(attempt.claim.Envelope.Kind) {
		return attempt.runTranscription(ctx)
	}
	if attempt.claim.Envelope.Kind != recordingpipeline.JobKindRender {
		return ErrInvalidProductionRenderAttempt
	}

	var resolved recordingrender.ResolvedInput
	err = attempt.measure(RenderAttemptStageResolveInput, func() error {
		var resolveErr error
		resolved, resolveErr = withRenderAuthority(attempt, func(authority recordingrender.Authority) (recordingrender.ResolvedInput, error) {
			return attempt.config.Control.ResolveRenderInput(ctx, authority)
		})
		return resolveErr
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
	if err := attempt.measure(RenderAttemptStageDownloadPresentation, func() error {
		return downloads.download(ctx, resolved.Presentation, presentationPath)
	}); err != nil {
		return fmt.Errorf("download recording presentation: %w", err)
	}
	if err := attempt.measure(RenderAttemptStageDownloadAssetManifest, func() error {
		return downloads.download(ctx, resolved.AssetManifest, assetManifestPath)
	}); err != nil {
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
	if err := attempt.measure(RenderAttemptStageStageAssets, func() error {
		return attempt.stageAssets(ctx, downloads, resolved, timeline, assetManifestPath, assetDirectory)
	}); err != nil {
		return err
	}
	var bundles []recordingdecode.BundleFile
	var inputBytes int64
	err = attempt.measure(RenderAttemptStageDownloadCapture, func() error {
		var downloadErr error
		bundles, inputBytes, downloadErr = attempt.downloadCapture(ctx, downloads, resolved, bundleDirectory)
		return downloadErr
	})
	if err != nil {
		return err
	}

	var dataKeys []recordingdecode.DataKey
	err = attempt.measure(RenderAttemptStageAccessCaptureKeys, func() error {
		var accessErr error
		dataKeys, accessErr = attempt.accessCaptureKeys(ctx, resolved.Capture)
		return accessErr
	})
	if err != nil {
		return err
	}
	defer clearDecodeDataKeys(dataKeys)
	decodedDirectory := filepath.Join(attempt.workspace, "decoded")
	var decoded recordingdecode.Result
	err = attempt.measure(RenderAttemptStageSourcePreparation, func() error {
		var decodeErr error
		decoded, decodeErr = attempt.config.Decode(ctx, recordingdecode.Request{
			RecordingID: timeline.RecordingID, EpisodeID: timeline.EpisodeID, TenantID: resolved.TenantID.String(),
			Environment: attempt.config.Environment, OriginAuthorityID: timeline.Clock.OriginAuthorityID,
			CaptureEpoch: resolved.CaptureEpoch, DurationMS: resolved.DurationMillis, OutputDirectory: decodedDirectory,
			FFmpegPath: attempt.config.FFmpegPath, Presentation: timeline, Bundles: bundles, DataKeys: dataKeys,
			VideoPassthrough: attempt.config.Compose != nil,
		})
		return decodeErr
	})
	clearDecodeDataKeys(dataKeys)
	if err != nil {
		return fmt.Errorf("decode authenticated recording media: %w", err)
	}

	if len(decoded.Index.Sources) == 0 {
		return fmt.Errorf("%w: recording has no decodable video or audio", recordingdecode.ErrDecode)
	}
	videoPath := filepath.Join(attempt.workspace, renderVideoName)
	frameRequest := FrameRenderRequest{
		SchemaVersion: FrameRenderRequestVersion, RecordingID: resolved.RecordingID.String(), EpisodeID: resolved.EpisodeID.String(),
		WorkspaceDirectory: attempt.workspace, PresentationPath: presentationPath, PresentationSHA256: hex.EncodeToString(resolved.PresentationSHA256),
		AssetDirectory: assetDirectory, DecodedMediaPath: decoded.IndexPath,
		DecodedMediaSHA256: decoded.IndexSHA256, Width: timeline.Initial.Profile.Viewport.Width, Height: timeline.Initial.Profile.Viewport.Height,
		FPS: nativeRenderFPS, DurationMs: resolved.DurationMillis,
	}
	expected, err := attempt.renderVideo(ctx, frameRequest, videoPath)
	if err != nil {
		return err
	}
	var mediaFacts MediaFacts
	err = attempt.measure(RenderAttemptStageProbe, func() error {
		var probeErr error
		mediaFacts, probeErr = VerifyRecordingMedia(ctx, attempt.config.Commands, videoPath, expected)
		return probeErr
	})
	if err != nil {
		return fmt.Errorf("verify encoded recording: %w", err)
	}
	factsBytes, err := json.Marshal(mediaFacts)
	if err != nil {
		return fmt.Errorf("encode recording media facts: %w", err)
	}
	factsDigest := sha256.Sum256(factsBytes)
	videoDuration := resolved.DurationMillis
	var video recordingrender.CommitObjectReference
	err = attempt.measure(RenderAttemptStagePersistVideo, func() error {
		var persistErr error
		video, persistErr = attempt.persistFile(ctx, recordingrender.PurposeRecordingVideo, "video", videoPath, &videoDuration)
		return persistErr
	})
	if err != nil {
		return err
	}

	commit := recordingrender.CommitInput{
		PresentationSHA256: append([]byte(nil), resolved.PresentationSHA256...),
		VideoDegradation:   decoded.VideoDegradation,
		DurationMillis:     resolved.DurationMillis, Video: video, FFprobeFactsDigest: append([]byte(nil), factsDigest[:]...),
	}
	if err := attempt.measure(RenderAttemptStageCommit, func() error {
		_, commitErr := withRenderAuthority(attempt, func(authority recordingrender.Authority) (recordingrender.CommitResult, error) {
			// Keep heartbeats out until an ambiguous final commit is confirmed.
			return retryRenderCall(ctx, attempt, "commit_render", func(ctx context.Context) (recordingrender.CommitResult, error) {
				commit.Authority = authority
				digest, digestErr := recordingrender.CommitDigest(commit)
				if digestErr != nil {
					return recordingrender.CommitResult{}, fmt.Errorf("digest recording render commit: %w", digestErr)
				}
				commit.CommitDigest = digest
				result, innerCommitErr := attempt.config.Control.CommitRender(ctx, commit)
				if innerCommitErr == nil {
					attempt.mu.Lock()
					attempt.committed = true
					attempt.mu.Unlock()
				}
				return result, innerCommitErr
			})
		})
		return commitErr
	}); err != nil {
		return fmt.Errorf("commit recording Artifact: %w", err)
	}
	_ = inputBytes
	return nil
}

func (attempt *ProductionRenderAttempt) renderVideo(ctx context.Context, request FrameRenderRequest, videoPath string) (RecordingMediaExpectation, error) {
	request.FPS = nativeRenderFPS
	expected, err := BuildRecordingMediaExpectation(request.Width, request.Height, request.FPS, request.DurationMs)
	if err != nil {
		return RecordingMediaExpectation{}, fmt.Errorf("build recording media expectation: %w", err)
	}
	if err := attempt.measure(RenderAttemptStageCompositionEncoding, func() error {
		_, composeErr := attempt.config.Compose.Compose(ctx, request, videoPath)
		return composeErr
	}); err != nil {
		return RecordingMediaExpectation{}, fmt.Errorf("compose recording video: %w", err)
	}
	return expected, nil
}

func (attempt *ProductionRenderAttempt) measure(stage RenderAttemptStage, action func() error) error {
	started := time.Now()
	err := action()
	if attempt.config.Observer != nil {
		attempt.config.Observer.ObserveRenderAttemptStage(RenderAttemptStageMeasurement{Stage: stage, WallDuration: time.Since(started), Succeeded: err == nil})
	}
	return err
}
