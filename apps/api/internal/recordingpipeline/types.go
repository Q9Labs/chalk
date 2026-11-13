package recordingpipeline

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaximumEpisodes            = 10
	MaximumParticipants        = 100
	MinimumEpisodeParticipants = 1
	MaximumEpisodeParticipants = 10
	MaximumRecordingDuration   = artifactpolicy.MaximumRecordingDuration
	// The c-2/two-page render profile took about 5.9 times media duration
	// on the qualified fixture. Keep an absolute budget across retries,
	// staging, and encoding for a maximum-length Recording.
	MaximumRenderDuration          = 7 * MaximumRecordingDuration
	MaximumInputBitrateBPS         = int64(4_000_000)
	DefaultPayloadSchemaVersion    = 1
	DefaultCaptureAttemptLimit     = 10
	DefaultRenderAttemptLimit      = 3
	CapturePrewarm                 = 5 * time.Minute
	SupportedPolicySnapshotVersion = artifactpolicy.SnapshotSchemaVersion
)

const (
	RecorderJobSchemaVersion             = "recorder_job.v2"
	LegacyRecorderJobSchemaVersion       = "recorder_job.v1"
	RecordingBundleSchema                = "recording_bundle.v2"
	LegacyRecordingBundleSchema          = "recording_bundle.v1"
	RecordingLayoutProfile               = "composite_720p_v1"
	RecorderInitialPlanRevision    int64 = 1
)

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
	CompletionOnly       bool
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
	SchemaVersion              string   `json:"schema_version"`
	TenantID                   string   `json:"tenant_id"`
	SpaceID                    string   `json:"space_id"`
	EpisodeID                  string   `json:"episode_id"`
	RecordingID                string   `json:"recording_id"`
	JobID                      string   `json:"job_id"`
	Kind                       JobKind  `json:"kind"`
	AttemptCount               int      `json:"attempt_count"`
	FencingGeneration          int64    `json:"fencing_generation"`
	CaptureEpoch               int64    `json:"capture_epoch"`
	CompletionOnly             bool     `json:"completion_only,omitempty"`
	PolicySnapshotVersion      string   `json:"policy_snapshot_version"`
	HardDeadline               string   `json:"hard_deadline"`
	CaptureReadyAt             *string  `json:"capture_ready_at"`
	RenderInputHandle          string   `json:"render_input_handle,omitempty"`
	PresentationHandle         string   `json:"presentation_handle,omitempty"`
	PresentationSchemaVersion  string   `json:"presentation_schema_version,omitempty"`
	PresentationProfileVersion string   `json:"presentation_profile_version,omitempty"`
	PresentationSHA256         string   `json:"presentation_sha256,omitempty"`
	PresentationDurationMillis int64    `json:"presentation_duration_ms,omitempty"`
	InitialPlanRevision        int64    `json:"initial_plan_revision"`
	BundleSchemaVersion        string   `json:"bundle_schema_version"`
	LayoutProfile              string   `json:"layout_profile"`
	ParticipantLimit           int      `json:"participant_limit"`
	InputBitrateBPS            int64    `json:"input_bitrate_bps"`
	AudioCodec                 string   `json:"audio_codec"`
	VideoCodecs                []string `json:"video_codecs"`
	PlanHandle                 string   `json:"plan_handle"`
	SignalingHandle            string   `json:"signaling_handle"`
	KeyHandle                  string   `json:"key_handle"`
	ObjectHandle               string   `json:"object_handle"`
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

type Repository interface {
	Reserve(ctx context.Context, input ReservationInput, captureJobID utilities.ID) (Reservation, error)
	GetReservation(ctx context.Context, tenantID, reservationID utilities.ID) (Reservation, error)
	ReleaseReservation(ctx context.Context, tenantID, reservationID utilities.ID, state ReservationState) (Reservation, error)
	ExtendReservation(ctx context.Context, tenantID, reservationID utilities.ID, duration time.Duration, endsAt time.Time) (Reservation, error)
	ExpireReservations(ctx context.Context, now time.Time) ([]Reservation, error)
	GetPipeline(ctx context.Context, tenantID, recordingID utilities.ID) (Pipeline, error)
	GetArtifactState(ctx context.Context, tenantID, recordingID utilities.ID) (ArtifactState, error)
	RequestExport(ctx context.Context, input ExportInput, renderJobID utilities.ID) (Job, error)
	RequestStop(ctx context.Context, tenantID, episodeID, recordingID, operationID utilities.ID) (Pipeline, error)
	Claim(ctx context.Context, input ClaimInput) (Job, error)
	Heartbeat(ctx context.Context, input LeaseInput) (Job, error)
	Complete(ctx context.Context, input LeaseInput) (Job, error)
	CompleteCapture(ctx context.Context, input LeaseInput, renderJobID utilities.ID) (Job, error)
	RelinquishCapture(ctx context.Context, input LeaseInput) (Job, error)
	Fail(ctx context.Context, input FailureInput) (Job, error)
	RecoverExpired(ctx context.Context) ([]Job, error)
	ListDeadLetters(ctx context.Context, tenantID utilities.ID, limit int) ([]Job, error)
	ListForReconciliation(ctx context.Context, query ReconciliationQuery) ([]Job, error)
	InsertBundle(ctx context.Context, input BundleInput) (Bundle, error)
	CommitArtifact(ctx context.Context, input ArtifactInput) (Artifact, error)
	UpsertPoolHealth(ctx context.Context, health PoolHealth) (PoolHealth, error)
	GetPoolHealth(ctx context.Context, role PoolRole) (PoolHealth, error)
	ListHeldCaptureSlots(ctx context.Context, limit int) ([]HeldCaptureSlot, error)
}
