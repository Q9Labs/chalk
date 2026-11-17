package recorderworker

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
)
