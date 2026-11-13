package recordingpipeline

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type State string

const (
	StateRequested          State = "requested"
	StateReserved           State = "reserved"
	StateCaptureLeased      State = "capture_leased"
	StateCapturingSegmented State = "capturing_segmented"
	StateCaptureComplete    State = "capture_complete"
	StateRenderQueued       State = "render_queued"
	StateRendering          State = "rendering"
	StateVerifying          State = "verifying"
	StateCommitted          State = "committed"
	StateRetryableFailure   State = "retryable_failure"
	StateTerminalFailure    State = "terminal_failure"
	StateDeleted            State = "deleted"
)

type JobKind string

const (
	JobKindCapture JobKind = "capture"
	// JobKindTranscription prepares the durable audio source consumed by the
	// transcription dispatcher. It deliberately does not produce an MP4.
	JobKindTranscription JobKind = "transcription"
	JobKindRender        JobKind = "render"
)

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

// ArtifactState backs the stable recording-artifact read model. Its source
// expiry is anchored at capture completion and never renewed by export reads.
type ArtifactState struct {
	SourceStatus      SourceStatus
	CaptureStopReason string
	SourceExpiresAt   *time.Time
	// TranscriptionPolicy is sealed in the Episode snapshot and defaults to
	// disabled for legacy or invalid snapshots. It never reflects mutable Space
	// policy.
	TranscriptionPolicy            artifactpolicy.TranscriptionMode
	TranscriptionPreparationStatus TranscriptionPreparationStatus
	// TranscriptionSourceExpiresAt is the transcription source's own expiry,
	// capped by the recording source window. It is nil when transcription is
	// disabled or no source exists yet.
	TranscriptionSourceExpiresAt *time.Time
	ExportJobID                  *utilities.ID
	ExportStatus                 ExportStatus
	Retryable                    bool
	FailureCode                  string
	FailureMessage               string
	TranscriptionFailureCode     string
}

type JobState string

const (
	JobStatePending          JobState = "pending"
	JobStateLeased           JobState = "leased"
	JobStateSucceeded        JobState = "succeeded"
	JobStateRetryableFailure JobState = "retryable_failure"
	JobStateTerminalFailure  JobState = "terminal_failure"
	JobStateCancelled        JobState = "cancelled"
)

type ReservationState string

const (
	ReservationStateReserved ReservationState = "reserved"
	ReservationStateReleased ReservationState = "released"
	ReservationStateExpired  ReservationState = "expired"
)
