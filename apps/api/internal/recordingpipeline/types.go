package recordingpipeline

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaximumMeetings             = 20
	MaximumParticipants         = 100
	MinimumMeetingParticipants  = 1
	MaximumMeetingParticipants  = 10
	MaximumRecordingDuration    = 2 * time.Hour
	MaximumInputBitrateBPS      = int64(4_000_000)
	MaximumInputBitrateTotalBPS = int64(MaximumMeetings) * MaximumInputBitrateBPS
	DefaultPayloadSchemaVersion = 1
	DefaultCaptureAttemptLimit  = 5
	DefaultRenderAttemptLimit   = 3
	CapturePrewarm              = 5 * time.Minute
)

var (
	ErrInvalidTenantID              = errors.New("invalid recording pipeline tenant id")
	ErrInvalidRoomID                = errors.New("invalid recording pipeline room id")
	ErrInvalidSessionID             = errors.New("invalid recording pipeline session id")
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
	ID               utilities.ID
	TenantID         utilities.ID
	RoomID           utilities.ID
	SessionID        utilities.ID
	RecordingID      utilities.ID
	IdempotencyKey   string
	ParticipantCount int
	MaxDuration      time.Duration
	InputBitrateBPS  int64
	StartsAt         *time.Time
}

type Reservation struct {
	ID               utilities.ID
	TenantID         utilities.ID
	RoomID           utilities.ID
	SessionID        utilities.ID
	RecordingID      utilities.ID
	IdempotencyKey   string
	ParticipantCount int
	MaxDuration      time.Duration
	InputBitrateBPS  int64
	State            ReservationState
	StartsAt         *time.Time
	EndsAt           time.Time
	UpdatedAt        time.Time
	CreatedAt        time.Time
}

type Pipeline struct {
	RecordingID        utilities.ID
	TenantID           utilities.ID
	ReservationID      utilities.ID
	State              State
	CaptureCompletedAt *time.Time
	CommittedAt        *time.Time
	UpdatedAt          time.Time
	CreatedAt          time.Time
}

type Job struct {
	ID                   utilities.ID
	TenantID             utilities.ID
	SessionID            utilities.ID
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
	ErrorCode            *string
	ErrorDetail          *string
	TerminalAt           *time.Time
	UpdatedAt            time.Time
	CreatedAt            time.Time
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
	Kind       JobKind
	Owner      string
	LeaseToken string
	LeaseFor   time.Duration
}

type LeaseInput struct {
	JobID             utilities.ID
	AttemptCount      int
	FencingGeneration int64
	LeaseToken        string
	LeaseOwner        string
	LeaseFor          time.Duration
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
