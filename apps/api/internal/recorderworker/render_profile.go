package recorderworker

import "time"

type RenderAttemptStage string

const (
	RenderAttemptStageResolveInput          RenderAttemptStage = "resolve_input"
	RenderAttemptStageDownloadPresentation  RenderAttemptStage = "download_presentation"
	RenderAttemptStageDownloadAssetManifest RenderAttemptStage = "download_asset_manifest"
	RenderAttemptStageStageAssets           RenderAttemptStage = "stage_assets"
	RenderAttemptStageDownloadCapture       RenderAttemptStage = "download_capture"
	RenderAttemptStageAccessCaptureKeys     RenderAttemptStage = "access_capture_keys"
	RenderAttemptStageSourcePreparation     RenderAttemptStage = "source_preparation"
	RenderAttemptStageCompositionEncoding   RenderAttemptStage = "composition_encoding"
	RenderAttemptStageProbe                 RenderAttemptStage = "probe"
	RenderAttemptStagePersistVideo          RenderAttemptStage = "persist_video"
	RenderAttemptStagePersistTranscription  RenderAttemptStage = "persist_transcription"
	RenderAttemptStageCommit                RenderAttemptStage = "commit"
	RenderAttemptStageCleanup               RenderAttemptStage = "cleanup"
)

type RenderAttemptStageMeasurement struct {
	Stage        RenderAttemptStage
	WallDuration time.Duration
	Succeeded    bool
}

type RenderFrameEncodingMeasurement struct {
	Result    FrameEncodeResult
	Succeeded bool
}

// RenderAttemptObserver is optional instrumentation for a render attempt.
// Production workers leave it nil; a bounded profiler supplies it to retain
// stage walls and the renderer's own timing result without changing the work.
type RenderAttemptObserver interface {
	ObserveRenderAttemptStage(RenderAttemptStageMeasurement)
	ObserveRenderFrameEncoding(RenderFrameEncodingMeasurement)
}
