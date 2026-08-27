package capturesignaling

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaximumSignalingHandle = captureplane.MaxProviderReference
	MaximumLeaseOwner      = 256
	MaximumLeaseToken      = 256
	MaximumProviderCode    = 128
	DefaultWait            = 30 * time.Second
	DefaultPollInterval    = 10 * time.Millisecond
)

// SignalingHandle identifies the serialized provider connection command stream.
// It is the UUID generated in the recorder_job.v1 envelope.
type SignalingHandle string

func NewSignalingHandle(value string) (SignalingHandle, error) {
	handle := SignalingHandle(value)
	if err := handle.Validate(); err != nil {
		return "", err
	}
	return handle, nil
}

func (h SignalingHandle) String() string { return string(h) }

// CommandAuthority is the immutable authority copied from recorder_job.v1.
// EnvelopeDigest is copied on every boundary and must be a non-zero SHA-256
// digest issued for this exact job attempt.
type CommandAuthority struct {
	TenantID          utilities.ID              `json:"tenant_id"`
	SpaceID           utilities.ID              `json:"space_id"`
	EpisodeID         utilities.ID              `json:"episode_id"`
	RecordingID       utilities.ID              `json:"recording_id"`
	JobID             utilities.ID              `json:"job_id"`
	AttemptCount      int                       `json:"attempt_count"`
	FencingGeneration int64                     `json:"fencing_generation"`
	CaptureEpoch      captureplane.CaptureEpoch `json:"capture_epoch"`
	EnvelopeDigest    []byte                    `json:"envelope_digest"`
}

// WorkerLease is the worker's short-lived mutation authority.
type WorkerLease struct {
	Owner     string    `json:"owner"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CommandIdentity is the stable operation identity.
type CommandIdentity struct {
	Operation      captureplane.OperationKind `json:"operation"`
	PlanRevision   captureplane.PlanRevision  `json:"plan_revision"`
	IdempotencyKey string                     `json:"idempotency_key"`
}

// CommandInput is a typed union of the six CapturePlane input values. Each
// command must set exactly one member.
type CommandInput struct {
	CreateCaptureConnection      *captureplane.CreateCaptureConnectionInput      `json:"create_capture_connection,omitempty"`
	PullCaptureTracks            *captureplane.PullCaptureTracksInput            `json:"pull_capture_tracks,omitempty"`
	RenegotiateCaptureConnection *captureplane.RenegotiateCaptureConnectionInput `json:"renegotiate_capture_connection,omitempty"`
	InspectCaptureConnection     *captureplane.InspectCaptureConnectionInput     `json:"inspect_capture_connection,omitempty"`
	CloseCaptureTracks           *captureplane.CloseCaptureTracksInput           `json:"close_capture_tracks,omitempty"`
	CloseCaptureConnection       *captureplane.CloseCaptureConnectionInput       `json:"close_capture_connection,omitempty"`
}

// CommandResult is the typed result union matching CommandInput.
type CommandResult struct {
	CreateCaptureConnection      *captureplane.CreateCaptureConnectionResult      `json:"create_capture_connection,omitempty"`
	PullCaptureTracks            *captureplane.PullCaptureTracksResult            `json:"pull_capture_tracks,omitempty"`
	RenegotiateCaptureConnection *captureplane.RenegotiateCaptureConnectionResult `json:"renegotiate_capture_connection,omitempty"`
	InspectCaptureConnection     *captureplane.InspectCaptureConnectionResult     `json:"inspect_capture_connection,omitempty"`
	CloseCaptureTracks           *captureplane.CloseCaptureTracksResult           `json:"close_capture_tracks,omitempty"`
	CloseCaptureConnection       *captureplane.CloseCaptureConnectionResult       `json:"close_capture_connection,omitempty"`
}

// Command is a worker request. Lease authority is intentionally excluded from
// canonical request fingerprints so lease renewal does not create a conflict.
type Command struct {
	SignalingHandle SignalingHandle  `json:"signaling_handle"`
	Authority       CommandAuthority `json:"authority"`
	Lease           WorkerLease      `json:"lease"`
	Identity        CommandIdentity  `json:"identity"`
	Input           CommandInput     `json:"input"`
}

// CommandKey is the durable primary identity of a command.
type CommandKey struct {
	SignalingHandle SignalingHandle            `json:"signaling_handle"`
	Operation       captureplane.OperationKind `json:"operation"`
	PlanRevision    captureplane.PlanRevision  `json:"plan_revision"`
	IdempotencyKey  string                     `json:"idempotency_key"`
}

// PreparedCommand is the authority and canonical typed input a persistence
// implementation validates before inserting a new command row.
type PreparedCommand struct {
	SignalingHandle SignalingHandle
	Authority       CommandAuthority
	Identity        CommandIdentity
	Input           CommandInput
}

// ConnectionProjection is enough state for the persistence layer to fence SDP
// answers to the offer that produced them.
type ConnectionProjection struct {
	SignalingHandle        SignalingHandle                     `json:"signaling_handle"`
	Connection             captureplane.CaptureConnection      `json:"connection"`
	CaptureEpoch           captureplane.CaptureEpoch           `json:"capture_epoch"`
	PlanRevision           captureplane.PlanRevision           `json:"plan_revision"`
	NegotiationID          captureplane.ProviderReference      `json:"negotiation_id,omitempty"`
	NegotiationRequirement captureplane.NegotiationRequirement `json:"negotiation_requirement"`
	State                  captureplane.CaptureConnectionState `json:"state,omitempty"`
	Closed                 bool                                `json:"closed"`
}

// StoredOutcome is a durable terminal result. ResultBytes are retained
// verbatim; ProviderFailure is bounded and contains no provider payload.
type StoredOutcome struct {
	ResultBytes     []byte                      `json:"result_bytes,omitempty"`
	ProviderFailure *captureplane.ProviderError `json:"provider_failure,omitempty"`
}

type PrepareRequest struct {
	Key          CommandKey
	Authority    CommandAuthority
	Lease        WorkerLease
	Input        CommandInput
	RequestBytes []byte
	Fingerprint  [32]byte
}

type PrepareResult struct {
	Prepared          bool
	Outcome           StoredOutcome
	CurrentProjection *ConnectionProjection
}

type ClaimRequest struct {
	Key          CommandKey
	Authority    CommandAuthority
	Lease        WorkerLease
	Input        CommandInput
	RequestBytes []byte
	Fingerprint  [32]byte
	Owner        string
	ClaimedAt    time.Time
}

type ClaimResult struct {
	Claimed           bool
	ClaimToken        string
	NotBefore         time.Time
	Outcome           StoredOutcome
	CurrentProjection *ConnectionProjection
	Ambiguous         bool
}

type Completion struct {
	Key         CommandKey
	Authority   CommandAuthority
	Lease       WorkerLease
	ClaimToken  string
	ResultBytes []byte
	Projection  *ConnectionProjection
}

// Release returns a claim to the queue only when the trusted service has not
// called CapturePlane. A stale or mismatched execution token must be rejected.
type Release struct {
	Key        CommandKey
	Authority  CommandAuthority
	Lease      WorkerLease
	ClaimToken string
}

type Failure struct {
	Key           CommandKey
	Authority     CommandAuthority
	Lease         WorkerLease
	ClaimToken    string
	ProviderError captureplane.ProviderError
}

// Port is the durable command persistence boundary. Implementations must
// serialize ClaimCommand by SignalingHandle and must never return an old
// in-flight command as a replay after its claim expires: return Ambiguous.
type Port interface {
	PrepareCommand(context.Context, PrepareRequest) (PrepareResult, error)
	ClaimCommand(context.Context, ClaimRequest) (ClaimResult, error)
	ReleaseCommand(context.Context, Release) error
	CompleteCommand(context.Context, Completion) error
	FailCommand(context.Context, Failure) error
}

type ExecuteRequest struct {
	Command Command
}

type Execution struct {
	Key         CommandKey
	Result      CommandResult
	ResultBytes []byte
	Replayed    bool
}

type Clock func() time.Time
type WaitFunc func(context.Context, time.Duration) error

type Options struct {
	Now          Clock
	Wait         WaitFunc
	PollInterval time.Duration
	MaxWait      time.Duration
}

func (o Options) withDefaults() Options {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Wait == nil {
		o.Wait = waitWithTimer
	}
	if o.PollInterval <= 0 {
		o.PollInterval = DefaultPollInterval
	}
	if o.MaxWait <= 0 {
		o.MaxWait = DefaultWait
	}
	return o
}
