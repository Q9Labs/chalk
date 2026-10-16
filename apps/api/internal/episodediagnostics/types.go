package episodediagnostics

import (
	"encoding/json"
	"time"
)

type Environment string

const (
	EnvironmentLocalhost   Environment = "localhost"
	EnvironmentDevelopment Environment = "development"
	EnvironmentStaging     Environment = "staging"
	EnvironmentProduction  Environment = "production"
)

type EventSource string

const (
	SourceUI       EventSource = "ui"
	SourceSDK      EventSource = "sdk"
	SourceAPI      EventSource = "api"
	SourceSync     EventSource = "sync"
	SourceRTC      EventSource = "rtc"
	SourceProvider EventSource = "provider"
	SourceWorker   EventSource = "worker"
)

type EventState string

const (
	EventStarted       EventState = "started"
	EventObserved      EventState = "observed"
	EventSucceeded     EventState = "succeeded"
	EventFailed        EventState = "failed"
	EventCancelled     EventState = "cancelled"
	EventTimedOut      EventState = "timed_out"
	EventNotObservable EventState = "not_observable"
	EventLateObserved  EventState = "late_observed"
)

type CheckpointClass string

const (
	CheckpointRequired    CheckpointClass = "required"
	CheckpointConditional CheckpointClass = "conditional"
	CheckpointBestEffort  CheckpointClass = "best_effort"
)

type UnknownReason string

const (
	UnknownNotRetained      UnknownReason = "not_retained"
	UnknownNotObservable    UnknownReason = "not_observable"
	UnknownRedacted         UnknownReason = "redacted"
	UnknownProviderOpaque   UnknownReason = "provider_opaque"
	UnknownExpired          UnknownReason = "expired"
	UnknownNotAvailable     UnknownReason = "not_available"
	UnknownInvalid          UnknownReason = "invalid"
	UnknownDiagnosticsOff   UnknownReason = "diagnostics_disabled"
	UnknownPermissionDenied UnknownReason = "permission_denied"
	UnknownReasonUnknown    UnknownReason = "unknown"
)

type DiagnosticEventExpectation struct {
	Name            string          `json:"name"`
	Version         int             `json:"version"`
	Checkpoint      string          `json:"checkpoint"`
	CheckpointClass CheckpointClass `json:"checkpointClass"`
	DeadlineAt      *time.Time      `json:"deadlineAt,omitempty"`
}

type DiagnosticEventCorrelation struct {
	JourneyID     string `json:"journeyId,omitempty"`
	TraceID       string `json:"traceId,omitempty"`
	SpanID        string `json:"spanId,omitempty"`
	RequestID     string `json:"requestId,omitempty"`
	CommandID     string `json:"commandId,omitempty"`
	ProviderID    string `json:"providerId,omitempty"`
	RetryGroupRef string `json:"retryGroupRef,omitempty"`
	Attempt       int64  `json:"attempt,omitempty"`
}

type DiagnosticRelease struct {
	ID           string `json:"id"`
	SourceCommit string `json:"sourceCommit,omitempty"`
}

type DiagnosticAttributes map[string]any

type DiagnosticEventDraft struct {
	Version                    int         `json:"version"`
	EventID                    string      `json:"eventId"`
	ProducerOperationRef       string      `json:"producerOperationRef,omitempty"`
	ParentProducerOperationRef string      `json:"parentProducerOperationRef,omitempty"`
	ProducerSequence           int64       `json:"producerSequence"`
	OccurredAt                 time.Time   `json:"occurredAt"`
	Source                     EventSource `json:"source"`
	Name                       string      `json:"name"`
	Phase                      string      `json:"phase"`
	State                      EventState  `json:"state"`
	// ParticipantID is authoritative row metadata, never intake input. Keep
	// it out of the wire shape and event fingerprint.
	ParticipantID string `json:"-"`
	// OperationID and BranchID are adapter/reducer hints for deterministic
	// worker-generated terminal events. They are never accepted from or
	// serialized into the public event contract; the persisted operation_id
	// column carries OperationID, while branch_id is recovered from the bounded
	// synthetic-event attribute when a branch terminal event is replayed.
	OperationID string                      `json:"-"`
	BranchID    string                      `json:"-"`
	Expectation *DiagnosticEventExpectation `json:"expectation,omitempty"`
	Correlation *DiagnosticEventCorrelation `json:"correlation,omitempty"`
	Release     *DiagnosticRelease          `json:"release,omitempty"`
	Attributes  DiagnosticAttributes        `json:"attributes,omitempty"`
}

type AcceptedDiagnosticEvent struct {
	DiagnosticEventDraft
	DiagnosticID string    `json:"diagnosticId"`
	Cursor       int64     `json:"cursor"`
	ReceivedAt   time.Time `json:"receivedAt"`
	Fingerprint  string    `json:"fingerprint"`
}

type AppendScope struct {
	TenantID      string `json:"tenantId"`
	SpaceID       string `json:"spaceId"`
	EpisodeID     string `json:"episodeId"`
	ParticipantID string `json:"participantId,omitempty"`
}

type ProducerIdentity struct {
	ID         string `json:"id"`
	InstanceID string `json:"instanceId"`
	Generation int64  `json:"generation"`
}

type AppendDiagnosticEventsRequest struct {
	Version  int                    `json:"version"`
	Producer ProducerIdentity       `json:"producer"`
	Scope    *AppendScope           `json:"scope,omitempty"`
	Events   []DiagnosticEventDraft `json:"events"`
}

type AppendConflict struct {
	EventID string `json:"eventId"`
	Code    string `json:"code"`
}

type AppendEventReceipt struct {
	EventID string `json:"eventId"`
	Cursor  int64  `json:"cursor"`
}

type AppendDiagnosticEventsResult struct {
	DiagnosticReference string               `json:"diagnosticReference"`
	CommittedCursor     int64                `json:"committedCursor"`
	Accepted            []AppendEventReceipt `json:"accepted"`
	Duplicates          []AppendEventReceipt `json:"duplicates"`
	Conflicts           []AppendConflict     `json:"conflicts"`
}

// MarshalJSON keeps empty acknowledgement collections stable for clients that
// distinguish an empty collection from a missing value.
func (result AppendDiagnosticEventsResult) MarshalJSON() ([]byte, error) {
	type appendResult AppendDiagnosticEventsResult
	if result.Accepted == nil {
		result.Accepted = []AppendEventReceipt{}
	}
	if result.Duplicates == nil {
		result.Duplicates = []AppendEventReceipt{}
	}
	if result.Conflicts == nil {
		result.Conflicts = []AppendConflict{}
	}
	return json.Marshal(appendResult(result))
}

type DiagnosticState string

const (
	DiagnosticLive     DiagnosticState = "live"
	DiagnosticEnded    DiagnosticState = "ended"
	DiagnosticComplete DiagnosticState = "complete"
	DiagnosticExpired  DiagnosticState = "expired"
)

type EpisodeDiagnostic struct {
	SchemaVersion       string          `json:"schemaVersion,omitempty"`
	ID                  string          `json:"id"`
	TenantID            string          `json:"tenantId"`
	SpaceID             string          `json:"spaceId"`
	EpisodeID           string          `json:"episodeId"`
	Environment         Environment     `json:"environment"`
	State               DiagnosticState `json:"state"`
	EpisodeStartedAt    time.Time       `json:"episodeStartedAt"`
	EpisodeEndedAt      *time.Time      `json:"episodeEndedAt,omitempty"`
	EpilogueCompletedAt *time.Time      `json:"epilogueCompletedAt,omitempty"`
	ExpiresAt           *time.Time      `json:"expiresAt,omitempty"`
	RunEndCursor        *int64          `json:"runEndCursor,omitempty"`
	CommittedCursor     int64           `json:"committedCursor"`
	ProjectedCursor     int64           `json:"projectedCursor"`
	// ConfigSnapshot is retained for repository compatibility only. Raw Episode
	// policy must not be serialized from the domain; callers use ConfigSummary.
	ConfigSnapshot map[string]any          `json:"-"`
	ConfigSummary  *EpisodeConfigSummaryV1 `json:"configSummary,omitempty"`
}

type BranchKind string

type BranchState string

const (
	BranchPending   BranchState = "pending"
	BranchRunning   BranchState = "running"
	BranchSucceeded BranchState = "succeeded"
	BranchFailed    BranchState = "failed"
	BranchCancelled BranchState = "cancelled"
	BranchTimedOut  BranchState = "timed_out"
)

type DiagnosticBranchDetail struct {
	SchemaVersion    string        `json:"schemaVersion,omitempty"`
	ID               string        `json:"id"`
	Reference        string        `json:"reference,omitempty"`
	Kind             BranchKind    `json:"kind"`
	State            BranchState   `json:"state"`
	LeaseEndsAt      time.Time     `json:"leaseEndsAt"`
	StartedAt        *time.Time    `json:"startedAt,omitempty"`
	TerminalAt       *time.Time    `json:"terminalAt,omitempty"`
	TerminalCursor   int64         `json:"terminalCursor,omitempty"`
	Attempts         int           `json:"attempts"`
	FanInChildren    []string      `json:"fanInChildren,omitempty"`
	LateObservations int           `json:"lateObservations,omitempty"`
	UnknownReason    UnknownReason `json:"unknownReason,omitempty"`
}

type ReferenceFocusKind string

const (
	ReferenceFocusOperation ReferenceFocusKind = "op"
	ReferenceFocusIssue     ReferenceFocusKind = "issue"
	ReferenceFocusEvent     ReferenceFocusKind = "event"
)

type DiagnosticReferenceFocus struct {
	Kind ReferenceFocusKind `json:"kind"`
	ID   string             `json:"id"`
}

type DiagnosticReference struct {
	Version      int                       `json:"version"`
	Environment  Environment               `json:"environment"`
	DiagnosticID string                    `json:"diagnosticId"`
	Focus        *DiagnosticReferenceFocus `json:"focus,omitempty"`
	Cursor       *int64                    `json:"cursor,omitempty"`
}
