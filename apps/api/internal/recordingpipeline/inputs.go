package recordingpipeline

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ReservationInput struct {
	ID                    utilities.ID
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	RecordingID           utilities.ID
	IdempotencyKey        string
	PolicySnapshotVersion string
	ParticipantCount      int
	MaxDuration           time.Duration
	InputBitrateBPS       int64
	StartsAt              *time.Time
}

type ClaimInput struct {
	// ManagedWorker is set by the authenticated HTTP boundary, never the request body.
	ManagedWorker          bool
	ClaimRequestID         utilities.ID
	Kind                   JobKind
	SupportsCompletionOnly bool
	Owner                  string
	LeaseToken             string
	LeaseFor               time.Duration
}

// ExportInput identifies the immutable Recording whose one canonical MP4
// export is requested. It intentionally carries no user-controlled output
// options: presentation, format, and source lifetime are frozen by the
// Episode policy and capture completion.
type ExportInput struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
}

type LeaseInput struct {
	JobID             utilities.ID
	AttemptCount      int
	FencingGeneration int64
	LeaseToken        string
	LeaseOwner        string
	LeaseFor          time.Duration
	CaptureEpoch      int64
	EnvelopeDigest    []byte
}

type FailureInput struct {
	LeaseInput
	AvailableAt time.Time
	ErrorCode   string
	ErrorDetail string
}

type ArtifactInput struct {
	RecordingID       utilities.ID
	TenantID          utilities.ID
	RenderJobID       utilities.ID
	ObjectKey         string
	ContentType       string
	ByteSize          int64
	Checksum          []byte
	Duration          time.Duration
	AttemptCount      int
	FencingGeneration int64
	LeaseToken        string
	LeaseOwner        string
	CaptureEpoch      int64
	EnvelopeDigest    []byte
}

type BundleInput struct {
	ID                   utilities.ID
	TenantID             utilities.ID
	RecordingID          utilities.ID
	CaptureJobID         utilities.ID
	SequenceNumber       int64
	FencingGeneration    int64
	AttemptCount         int
	LeaseToken           string
	LeaseOwner           string
	CaptureEpoch         int64
	EnvelopeDigest       []byte
	ObjectKey            string
	ContentType          string
	Codec                string
	Layer                *string
	ByteSize             int64
	Checksum             []byte
	MonotonicStartMillis int64
	MonotonicEndMillis   int64
	MediaStartMillis     int64
	MediaEndMillis       int64
}

type ReconciliationQuery struct {
	StaleBefore    time.Time
	TerminalBefore time.Time
	Limit          int
}
