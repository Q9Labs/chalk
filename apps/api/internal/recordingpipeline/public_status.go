package recordingpipeline

// SourceStatus describes whether capture-completion-frozen recording inputs
// may still be used. It is independent from the transcript and MP4 states.
type SourceStatus string

const (
	SourceStatusPending   SourceStatus = "pending"
	SourceStatusAvailable SourceStatus = "available"
	SourceStatusFailed    SourceStatus = "failed"
	SourceStatusExpired   SourceStatus = "expired"
)

type ExportStatus string

const (
	ExportStatusNone        ExportStatus = "none"
	ExportStatusPending     ExportStatus = "pending"
	ExportStatusReady       ExportStatus = "ready"
	ExportStatusFailed      ExportStatus = "failed"
	ExportStatusUnavailable ExportStatus = "unavailable"
)

// TranscriptionPreparationStatus describes audio preparation independently of
// Capture, Video Export, and the Transcript artifact itself.
type TranscriptionPreparationStatus string

const (
	TranscriptionPreparationNone    TranscriptionPreparationStatus = "none"
	TranscriptionPreparationPending TranscriptionPreparationStatus = "pending"
	TranscriptionPreparationReady   TranscriptionPreparationStatus = "ready"
	TranscriptionPreparationFailed  TranscriptionPreparationStatus = "failed"
	TranscriptionPreparationExpired TranscriptionPreparationStatus = "expired"
)
