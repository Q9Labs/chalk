package recordingpipeline

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaximumEpisodes                = 20
	MaximumParticipants            = 100
	MinimumEpisodeParticipants     = 1
	MaximumEpisodeParticipants     = 10
	MaximumRecordingDuration       = 2 * time.Hour
	MaximumRenderDuration          = 30 * time.Minute
	MaximumInputBitrateBPS         = int64(4_000_000)
	MaximumInputBitrateTotalBPS    = int64(MaximumEpisodes) * MaximumInputBitrateBPS
	DefaultPayloadSchemaVersion    = 1
	DefaultCaptureAttemptLimit     = 5
	DefaultRenderAttemptLimit      = 3
	CapturePrewarm                 = 5 * time.Minute
	SupportedPolicySnapshotVersion = artifactpolicy.SnapshotSchemaVersion
)

var (
	ErrInvalidTenantID              = errors.New("invalid recording pipeline tenant id")
	ErrInvalidSpaceID               = errors.New("invalid recording pipeline space id")
	ErrInvalidEpisodeID             = errors.New("invalid recording pipeline episode id")
	ErrInvalidRecordingID           = errors.New("invalid recording pipeline recording id")
	ErrInvalidReservationID         = errors.New("invalid recording reservation id")
	ErrInvalidJobID                 = errors.New("invalid recording job id")
	ErrInvalidParticipantCount      = errors.New("recording participant count must be between one and ten")
	ErrInvalidDuration              = errors.New("recording duration must be greater than zero and at most two hours")
	ErrInvalidInputBitrate          = errors.New("recording input bitrate must be greater than zero and at most four Mbps")
	ErrExtensionUnavailable         = errors.New("recording reservation extension is fail-closed until render capacity is qualified")
	ErrReservationConflict          = errors.New("recording reservation idempotency conflict")
	ErrCapacityExceeded             = errors.New("recording capacity exceeded")
	ErrRecordingCapacityUnavailable = ErrCapacityExceeded
	ErrReservationExpired           = errors.New("recording reservation expired before capture")
	ErrInvalidIdempotencyKey        = errors.New("invalid recording idempotency key")
	ErrInvalidOwner                 = errors.New("invalid recording lease owner")
	ErrInvalidLease                 = errors.New("invalid recording lease")
	ErrInvalidAttempt               = errors.New("invalid recording attempt")
	ErrInvalidStateTransition       = errors.New("invalid recording state transition")
	ErrReservationNotFound          = errors.New("recording reservation not found")
	ErrPipelineNotFound             = errors.New("recording pipeline not found")
	ErrJobNotFound                  = errors.New("recording job not found or lease lost")
	ErrArtifactNotFound             = errors.New("recording artifact not found")
	ErrArtifactConflict             = errors.New("recording artifact metadata conflict")
	ErrPoolHealthNotFound           = errors.New("recording pool health not found")
	ErrStopConflict                 = errors.New("recording stop operation conflict")
	ErrInvalidPolicySnapshotVersion = errors.New("invalid Recording policy snapshot version")
	ErrClaimConflict                = errors.New("recording claim request conflict")
	ErrInvalidEnvelope              = errors.New("invalid recorder job envelope")
)

const (
	RecorderJobSchemaVersion          = "recorder_job.v1"
	RecordingBundleSchema             = "recording_bundle.v1"
	RecordingLayoutProfile            = "composite_720p_v1"
	RecorderInitialPlanRevision int64 = 1
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
	JobKindRender  JobKind = "render"
)

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

type Reservation struct {
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
	State                 ReservationState
	StartsAt              *time.Time
	EndsAt                time.Time
	UpdatedAt             time.Time
	CreatedAt             time.Time
}

type Pipeline struct {
	RecordingID        utilities.ID
	TenantID           utilities.ID
	ReservationID      utilities.ID
	State              State
	CaptureEpoch       int64
	StopOperationID    *utilities.ID
	StopRequestedAt    *time.Time
	CaptureCompletedAt *time.Time
	CommittedAt        *time.Time
	UpdatedAt          time.Time
	CreatedAt          time.Time
}

type Job struct {
	ID                   utilities.ID
	TenantID             utilities.ID
	EpisodeID            utilities.ID
	RecordingID          utilities.ID
	Kind                 JobKind
	IdempotencyKey       string
	PayloadSchemaVersion int
	State                JobState
	Priority             int
	AvailableAt          time.Time
	AttemptCount         int
	AttemptLimit         int
	LeaseToken           *string
	LeaseOwner           *string
	LeaseExpiresAt       *time.Time
	FencingGeneration    int64
	CaptureEpoch         int64
	ErrorCode            *string
	ErrorDetail          *string
	TerminalAt           *time.Time
	UpdatedAt            time.Time
	CreatedAt            time.Time
	Authority            *JobAuthority
}

// RecorderJobEnvelope is the immutable, server-issued authority passed to a
// recorder worker for one job attempt. Its JSON bytes are hashed and stored
// with the attempt authority row before the claim is acknowledged.
type RecorderJobEnvelope struct {
	SchemaVersion         string   `json:"schema_version"`
	TenantID              string   `json:"tenant_id"`
	SpaceID               string   `json:"space_id"`
	EpisodeID             string   `json:"episode_id"`
	RecordingID           string   `json:"recording_id"`
	JobID                 string   `json:"job_id"`
	Kind                  JobKind  `json:"kind"`
	AttemptCount          int      `json:"attempt_count"`
	FencingGeneration     int64    `json:"fencing_generation"`
	CaptureEpoch          int64    `json:"capture_epoch"`
	PolicySnapshotVersion string   `json:"policy_snapshot_version"`
	HardDeadline          string   `json:"hard_deadline"`
	InitialPlanRevision   int64    `json:"initial_plan_revision"`
	BundleSchemaVersion   string   `json:"bundle_schema_version"`
	LayoutProfile         string   `json:"layout_profile"`
	ParticipantLimit      int      `json:"participant_limit"`
	InputBitrateBPS       int64    `json:"input_bitrate_bps"`
	AudioCodec            string   `json:"audio_codec"`
	VideoCodecs           []string `json:"video_codecs"`
	PlanHandle            string   `json:"plan_handle"`
	SignalingHandle       string   `json:"signaling_handle"`
	KeyHandle             string   `json:"key_handle"`
	ObjectHandle          string   `json:"object_handle"`
}

type JobAuthority struct {
	ClaimRequestID utilities.ID
	Envelope       RecorderJobEnvelope
	EnvelopeBytes  []byte
	EnvelopeDigest []byte
	LeaseOwner     string
	LeaseToken     string
	LeaseExpiresAt time.Time
	IssuedAt       time.Time
}

type Bundle struct {
	ID                   utilities.ID
	TenantID             utilities.ID
	RecordingID          utilities.ID
	CaptureJobID         utilities.ID
	SequenceNumber       int64
	FencingGeneration    int64
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
	CreatedAt            time.Time
}

type Artifact struct {
	RecordingID utilities.ID
	TenantID    utilities.ID
	RenderJobID utilities.ID
	ObjectKey   string
	ContentType string
	ByteSize    int64
	Checksum    []byte
	Duration    time.Duration
	CommittedAt time.Time
	CreatedAt   time.Time
}

type ClaimInput struct {
	ClaimRequestID utilities.ID
	Kind           JobKind
	Owner          string
	LeaseToken     string
	LeaseFor       time.Duration
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

type PoolRole string

const (
	PoolRoleCapture PoolRole = "capture"
	PoolRoleRender  PoolRole = "render"
)

type PoolHealth struct {
	Role          PoolRole
	AdmissionOpen bool
	ReadyCapacity int
	Reason        string
	ObservedAt    time.Time
	UpdatedAt     time.Time
}

type Repository interface {
	Reserve(ctx context.Context, input ReservationInput, captureJobID utilities.ID) (Reservation, error)
	GetReservation(ctx context.Context, tenantID, reservationID utilities.ID) (Reservation, error)
	ReleaseReservation(ctx context.Context, tenantID, reservationID utilities.ID, state ReservationState) (Reservation, error)
	ExtendReservation(ctx context.Context, tenantID, reservationID utilities.ID, duration time.Duration, endsAt time.Time) (Reservation, error)
	ExpireReservations(ctx context.Context, now time.Time) ([]Reservation, error)
	GetPipeline(ctx context.Context, tenantID, recordingID utilities.ID) (Pipeline, error)
	RequestStop(ctx context.Context, tenantID, episodeID, recordingID, operationID utilities.ID) (Pipeline, error)
	Claim(ctx context.Context, input ClaimInput) (Job, error)
	Heartbeat(ctx context.Context, input LeaseInput) (Job, error)
	Complete(ctx context.Context, input LeaseInput) (Job, error)
	CompleteCapture(ctx context.Context, input LeaseInput, renderJobID utilities.ID) (Job, error)
	Fail(ctx context.Context, input FailureInput) (Job, error)
	RecoverExpired(ctx context.Context) ([]Job, error)
	ListDeadLetters(ctx context.Context, tenantID utilities.ID, limit int) ([]Job, error)
	ListForReconciliation(ctx context.Context, query ReconciliationQuery) ([]Job, error)
	InsertBundle(ctx context.Context, input BundleInput) (Bundle, error)
	CommitArtifact(ctx context.Context, input ArtifactInput) (Artifact, error)
	UpsertPoolHealth(ctx context.Context, health PoolHealth) (PoolHealth, error)
	GetPoolHealth(ctx context.Context, role PoolRole) (PoolHealth, error)
}
