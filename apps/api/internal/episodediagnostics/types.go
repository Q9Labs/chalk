package episodediagnostics

import "time"

// Contract values are intentionally closed. Keep additions in lockstep with
// packages/diagnostics-contracts/src/allowlists.ts.
type Environment string

const (
	EnvironmentLocalhost   Environment = "localhost"
	EnvironmentDevelopment Environment = "development"
	EnvironmentStaging     Environment = "staging"
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

// DiagnosticAttributes only carries scalar values. Validation rejects a map
// entry that is not a bool, a finite number, or a bounded safe string.
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

// DiagnosticEvent is retained as the short contract-facing alias used by
// callers that do not need to distinguish the accepted envelope.
type DiagnosticEvent = DiagnosticEventDraft

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

// These aliases make the operation name readable at API call sites while
// keeping one wire shape.
type DiagnosticAppendRequest = AppendDiagnosticEventsRequest
type DiagnosticEventAppendRequest = AppendDiagnosticEventsRequest

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

type DiagnosticAppendResult = AppendDiagnosticEventsResult
type DiagnosticEventAppendResult = AppendDiagnosticEventsResult

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

type OperationState string

const (
	OperationRunning   OperationState = "running"
	OperationRetrying  OperationState = "retrying"
	OperationSucceeded OperationState = "succeeded"
	OperationFailed    OperationState = "failed"
	OperationStalled   OperationState = "stalled"
	OperationCancelled OperationState = "cancelled"
	OperationTimedOut  OperationState = "timed_out"
)

type CheckpointState string

const (
	CheckpointPending       CheckpointState = "pending"
	CheckpointObserved      CheckpointState = "observed"
	CheckpointMissed        CheckpointState = "missed"
	CheckpointNotObservable CheckpointState = "not_observable"
	CheckpointLateObserved  CheckpointState = "late_observed"
)

type DiagnosticCheckpointDetail struct {
	Key            string          `json:"key"`
	Class          CheckpointClass `json:"class"`
	DisplayOrder   int             `json:"displayOrder"`
	State          CheckpointState `json:"state"`
	DeadlineAt     *time.Time      `json:"deadlineAt,omitempty"`
	EvidenceCursor int64           `json:"evidenceCursor,omitempty"`
	UnknownReason  UnknownReason   `json:"unknownReason,omitempty"`
	Predicate      string          `json:"predicate,omitempty"`
}

type SafeIdentifier struct {
	IDClass       string        `json:"idClass"`
	Value         string        `json:"value,omitempty"`
	UnknownReason UnknownReason `json:"unknownReason,omitempty"`
	Copyable      bool          `json:"copyable"`
}

// Identifier fields are interface values because v1 permits either a raw
// safe identifier string or a SafeIdentifier carrying an explicit omission.
type DiagnosticOperationDetail struct {
	SchemaVersion        string                       `json:"schemaVersion,omitempty"`
	ID                   string                       `json:"id"`
	Reference            string                       `json:"reference,omitempty"`
	DiagnosticReference  string                       `json:"diagnosticReference,omitempty"`
	ParentID             string                       `json:"parentId,omitempty"`
	BranchID             string                       `json:"branchId,omitempty"`
	Kind                 string                       `json:"kind"`
	ExpectationVersion   int                          `json:"expectationVersion"`
	State                OperationState               `json:"state"`
	Attempt              int                          `json:"attempt"`
	RetryGroup           any                          `json:"retryGroup,omitempty"`
	StartedAt            time.Time                    `json:"startedAt"`
	DeadlineAt           *time.Time                   `json:"deadlineAt,omitempty"`
	GraceEndsAt          *time.Time                   `json:"graceEndsAt,omitempty"`
	EndedAt              *time.Time                   `json:"endedAt,omitempty"`
	DurationMilliseconds int64                        `json:"durationMilliseconds,omitempty"`
	Checkpoints          []DiagnosticCheckpointDetail `json:"checkpoints"`
	ErrorClass           string                       `json:"errorClass,omitempty"`
	RequestID            any                          `json:"requestId,omitempty"`
	CommandID            any                          `json:"commandId,omitempty"`
	ProviderID           any                          `json:"providerId,omitempty"`
	JourneyID            any                          `json:"journeyId,omitempty"`
	TraceID              any                          `json:"traceId,omitempty"`
	SpanID               any                          `json:"spanId,omitempty"`
	Source               EventSource                  `json:"source"`
	ReleaseID            string                       `json:"releaseId,omitempty"`
	SourceCommit         string                       `json:"sourceCommit,omitempty"`
	ClockUncertainty     string                       `json:"clockUncertainty,omitempty"`
	VisibilityGaps       []string                     `json:"visibilityGaps,omitempty"`
	// FirstEvidenceCursor is durable paging metadata, not a public projection
	// field. It is immutable after the operation is first observed.
	FirstEvidenceCursor int64  `json:"-"`
	ParticipantID       string `json:"-"`
	// ProviderLookupID carries only the environment-HMACed provider token used
	// by indexed filters and alternate-reference lookup. Public projections use
	// ProviderID, which deliberately remains opaque and non-copyable.
	ProviderLookupID string `json:"-"`
}

type IssueSeverity string

const (
	IssueInfo     IssueSeverity = "info"
	IssueWarning  IssueSeverity = "warning"
	IssueError    IssueSeverity = "error"
	IssueCritical IssueSeverity = "critical"
)

type IssueState string

const (
	IssueOpen     IssueState = "open"
	IssueResolved IssueState = "resolved"
)

type DiagnosticIssueDetail struct {
	SchemaVersion           string                     `json:"schemaVersion,omitempty"`
	ID                      string                     `json:"id"`
	Reference               string                     `json:"reference,omitempty"`
	DiagnosticReference     string                     `json:"diagnosticReference,omitempty"`
	OperationID             string                     `json:"operationId,omitempty"`
	Affected                *DiagnosticAffectedSubject `json:"affected,omitempty"`
	Kind                    string                     `json:"kind"`
	Severity                IssueSeverity              `json:"severity"`
	State                   IssueState                 `json:"state"`
	Summary                 string                     `json:"summary"`
	FirstObservedAt         time.Time                  `json:"firstObservedAt"`
	LastObservedAt          *time.Time                 `json:"lastObservedAt,omitempty"`
	ResolvedAt              *time.Time                 `json:"resolvedAt,omitempty"`
	LastConfirmedCheckpoint string                     `json:"lastConfirmedCheckpoint,omitempty"`
	MissingCheckpoint       string                     `json:"missingCheckpoint,omitempty"`
	RetryState              string                     `json:"retryState,omitempty"`
	UnknownReason           UnknownReason              `json:"unknownReason,omitempty"`
}

// DiagnosticAffectedSubject identifies the bounded subject most likely
// affected by an issue. Identifiers are SafeIdentifier values so raw
// provider/customer-sensitive values cannot escape the projection.
type DiagnosticAffectedSubject struct {
	Kind       string         `json:"kind"`
	Identifier SafeIdentifier `json:"identifier"`
}

type BranchKind string

const (
	BranchCleanup       BranchKind = "cleanup"
	BranchRecording     BranchKind = "recording"
	BranchTranscription BranchKind = "transcription"
	BranchArtifact      BranchKind = "artifact"
	BranchWebhook       BranchKind = "webhook"
)

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

type DiagnosticSummary struct {
	EventCount       int64 `json:"eventCount"`
	OperationCount   int64 `json:"operationCount"`
	IssueCount       int64 `json:"issueCount"`
	OpenIssueCount   int64 `json:"openIssueCount"`
	ParticipantCount int64 `json:"participantCount,omitempty"`
}

type DisplayValue struct {
	Value         string        `json:"value,omitempty"`
	UnknownReason UnknownReason `json:"unknownReason,omitempty"`
}

type ParticipantProjectionV1 struct {
	SchemaVersion  string             `json:"schemaVersion"`
	ParticipantID  string             `json:"participantId"`
	AnonymousLabel string             `json:"anonymousLabel"`
	IdentityKind   string             `json:"identityKind"`
	State          string             `json:"state"`
	JoinedAt       *time.Time         `json:"joinedAt,omitempty"`
	LeftAt         *time.Time         `json:"leftAt,omitempty"`
	Visibility     string             `json:"visibility"`
	VisibilityGaps []string           `json:"visibilityGaps"`
	OperationCount int64              `json:"operationCount"`
	IssueCount     int64              `json:"issueCount"`
	Display        ParticipantDisplay `json:"display"`
}

type ParticipantDisplay struct {
	Label       DisplayValue `json:"label"`
	RawIdentity DisplayValue `json:"rawIdentity"`
}

type RunParticipantLane struct {
	ParticipantID string   `json:"participantId"`
	OperationIDs  []string `json:"operationIds"`
	State         string   `json:"state"`
}

type RunProjectionV1 struct {
	SchemaVersion           string               `json:"schemaVersion"`
	State                   string               `json:"state"`
	StartedAt               time.Time            `json:"startedAt"`
	EndedAt                 *time.Time           `json:"endedAt,omitempty"`
	ElapsedMilliseconds     int64                `json:"elapsedMilliseconds"`
	ParticipantCount        int64                `json:"participantCount"`
	ActiveOperationCount    int64                `json:"activeOperationCount"`
	OpenIssueCount          int64                `json:"openIssueCount"`
	LatestConfirmedBoundary *DisplayValue        `json:"latestConfirmedBoundary,omitempty"`
	FirstMissingBoundary    *DisplayValue        `json:"firstMissingBoundary,omitempty"`
	ParticipantLanes        []RunParticipantLane `json:"participantLanes"`
}

type GraphNode struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Label          string `json:"label"`
	State          string `json:"state"`
	OperationCount int64  `json:"operationCount"`
	IssueCount     int64  `json:"issueCount"`
}

type GraphEdge struct {
	ID           string   `json:"id"`
	From         string   `json:"from"`
	To           string   `json:"to"`
	State        string   `json:"state"`
	OperationIDs []string `json:"operationIds"`
	IssueIDs     []string `json:"issueIds"`
}

type GraphProjectionV1 struct {
	SchemaVersion string       `json:"schemaVersion"`
	Nodes         []GraphNode  `json:"nodes"`
	Edges         []GraphEdge  `json:"edges"`
	Summary       GraphSummary `json:"summary"`
}

type GraphSummary struct {
	NodeCount         int64 `json:"nodeCount"`
	EdgeCount         int64 `json:"edgeCount"`
	ActiveCount       int64 `json:"activeCount"`
	FailedCount       int64 `json:"failedCount"`
	UnobservableCount int64 `json:"unobservableCount"`
}

type FlameBar struct {
	ID          string         `json:"id"`
	OperationID string         `json:"operationId,omitempty"`
	StartAt     time.Time      `json:"startAt"`
	EndAt       *time.Time     `json:"endAt,omitempty"`
	State       OperationState `json:"state"`
	Attempt     int            `json:"attempt,omitempty"`
	RetryGroup  string         `json:"retryGroup,omitempty"`
}

type FlameLane struct {
	ID     string      `json:"id"`
	Label  string      `json:"label"`
	Source EventSource `json:"source"`
	Bars   []FlameBar  `json:"bars"`
}

type FlameBucket struct {
	StartAt     time.Time `json:"startAt"`
	EndAt       time.Time `json:"endAt"`
	Count       int64     `json:"count"`
	FailedCount int64     `json:"failedCount"`
	Heat        float64   `json:"heat"`
}

type FlameHeat struct {
	LaneID    string    `json:"laneId"`
	StartAt   time.Time `json:"startAt"`
	EndAt     time.Time `json:"endAt"`
	Intensity float64   `json:"intensity"`
}

type FlameProjectionV1 struct {
	SchemaVersion string        `json:"schemaVersion"`
	Lanes         []FlameLane   `json:"lanes"`
	Buckets       []FlameBucket `json:"buckets"`
	Heat          []FlameHeat   `json:"heat"`
}

type EpilogueProjectionV1 struct {
	SchemaVersion        string                   `json:"schemaVersion"`
	State                string                   `json:"state"`
	CompletedAt          *time.Time               `json:"completedAt,omitempty"`
	Branches             []DiagnosticBranchDetail `json:"branches"`
	OpenBranchCount      int64                    `json:"openBranchCount"`
	TerminalBranchCount  int64                    `json:"terminalBranchCount"`
	LatestTerminalCursor int64                    `json:"latestTerminalCursor,omitempty"`
}

type DiagnosticSnapshotV1 struct {
	SchemaVersion   string                      `json:"schemaVersion"`
	Reference       string                      `json:"reference"`
	Environment     Environment                 `json:"environment"`
	State           DiagnosticState             `json:"state"`
	CapturedAt      time.Time                   `json:"capturedAt"`
	CommittedCursor int64                       `json:"committedCursor"`
	ProjectedCursor int64                       `json:"projectedCursor"`
	RunEndCursor    *int64                      `json:"runEndCursor,omitempty"`
	Summary         DiagnosticSummary           `json:"summary"`
	Operations      []DiagnosticOperationDetail `json:"operations"`
	Issues          []DiagnosticIssueDetail     `json:"issues"`
	Branches        []DiagnosticBranchDetail    `json:"branches"`
	Participants    []ParticipantProjectionV1   `json:"participants,omitempty"`
	Run             *RunProjectionV1            `json:"run,omitempty"`
	Graph           *GraphProjectionV1          `json:"graph,omitempty"`
	Flame           *FlameProjectionV1          `json:"flame,omitempty"`
	Epilogue        *EpilogueProjectionV1       `json:"epilogue,omitempty"`
	Omissions       []string                    `json:"omissions,omitempty"`
}

type DiagnosticResolverResponseV1 struct {
	Kind      string                     `json:"kind"`
	Reference string                     `json:"reference,omitempty"`
	Snapshot  *DiagnosticSnapshotV1      `json:"snapshot,omitempty"`
	Operation *DiagnosticOperationDetail `json:"operation,omitempty"`
	Issue     *DiagnosticIssueDetail     `json:"issue,omitempty"`
	Event     *AcceptedDiagnosticEvent   `json:"event,omitempty"`
	Reason    string                     `json:"reason,omitempty"`
}

type AgentBriefQueryV1 struct {
	SchemaVersion string `json:"schemaVersion"`
	Reference     string `json:"reference"`
	Cursor        *int64 `json:"cursor,omitempty"`
	Format        string `json:"format"`
	AroundSeconds int64  `json:"aroundSeconds,omitempty"`
	BranchID      string `json:"branchId,omitempty"`
}

type AgentBriefResponseV1 struct {
	SchemaVersion string       `json:"schemaVersion"`
	Format        string       `json:"format"`
	Brief         AgentBriefV1 `json:"brief"`
	Markdown      string       `json:"markdown,omitempty"`
}

type DiagnosticEventPageV1 struct {
	SchemaVersion     string                    `json:"schemaVersion"`
	Reference         string                    `json:"reference"`
	Events            []AcceptedDiagnosticEvent `json:"events"`
	CommittedCursor   int64                     `json:"committedCursor"`
	ProjectedCursor   int64                     `json:"projectedCursor"`
	AfterCursor       *int64                    `json:"afterCursor,omitempty"`
	BeforeCursor      *int64                    `json:"beforeCursor,omitempty"`
	NextCursor        *int64                    `json:"nextCursor,omitempty"`
	HasMore           bool                      `json:"hasMore"`
	FilterFingerprint string                    `json:"filterFingerprint"`
}

type DiagnosticOperationPageV1 struct {
	SchemaVersion     string                      `json:"schemaVersion"`
	Reference         string                      `json:"reference"`
	Operations        []DiagnosticOperationDetail `json:"operations"`
	CommittedCursor   int64                       `json:"committedCursor"`
	ProjectedCursor   int64                       `json:"projectedCursor"`
	NextCursor        *int64                      `json:"nextCursor,omitempty"`
	HasMore           bool                        `json:"hasMore"`
	FilterFingerprint string                      `json:"filterFingerprint"`
}

type StreamDeltaKind string

const (
	StreamEventAppended    StreamDeltaKind = "event_appended"
	StreamOperationUpdated StreamDeltaKind = "operation_updated"
	StreamIssueUpdated     StreamDeltaKind = "issue_updated"
	StreamBranchUpdated    StreamDeltaKind = "branch_updated"
	StreamSnapshot         StreamDeltaKind = "snapshot"
	StreamDeltaGap         StreamDeltaKind = "gap"
)

type DiagnosticStreamDeltaV1 struct {
	SchemaVersion     string                     `json:"schemaVersion"`
	Reference         string                     `json:"reference"`
	Cursor            int64                      `json:"cursor"`
	Kind              StreamDeltaKind            `json:"kind"`
	FilterFingerprint string                     `json:"filterFingerprint"`
	Event             *AcceptedDiagnosticEvent   `json:"event,omitempty"`
	Operation         *DiagnosticOperationDetail `json:"operation,omitempty"`
	Issue             *DiagnosticIssueDetail     `json:"issue,omitempty"`
	Branch            *DiagnosticBranchDetail    `json:"branch,omitempty"`
	Snapshot          *DiagnosticSnapshotV1      `json:"snapshot,omitempty"`
	Gap               *StreamGap                 `json:"gap,omitempty"`
}

type StreamGap struct {
	FromCursor *int64 `json:"fromCursor,omitempty"`
	ToCursor   *int64 `json:"toCursor,omitempty"`
	Reason     string `json:"reason"`
}

type DiagnosticStreamControlV1 struct {
	SchemaVersion            string `json:"schemaVersion"`
	HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
	MaxConnectionSeconds     int    `json:"maxConnectionSeconds"`
	AfterCursor              int64  `json:"afterCursor"`
	FilterFingerprint        string `json:"filterFingerprint"`
	MaxPendingDeltas         int    `json:"maxPendingDeltas"`
}

type DiagnosticStreamCloseV1 struct {
	SchemaVersion   string `json:"schemaVersion"`
	Reason          string `json:"reason"`
	ResumableCursor int64  `json:"resumableCursor"`
	RefillRequired  bool   `json:"refillRequired"`
}

type DiagnosticStreamStatusV1 struct {
	SchemaVersion            string `json:"schemaVersion"`
	Connected                bool   `json:"connected"`
	LastCursor               int64  `json:"lastCursor"`
	CommittedCursor          int64  `json:"committedCursor"`
	ProjectedCursor          int64  `json:"projectedCursor"`
	ProjectorLagMilliseconds int64  `json:"projectorLagMilliseconds"`
	GapRefillRequired        bool   `json:"gapRefillRequired"`
}

type DiagnosticFilterV1 struct {
	SchemaVersion string      `json:"schemaVersion"`
	ParticipantID string      `json:"participantId,omitempty"`
	Source        EventSource `json:"source,omitempty"`
	OperationKind string      `json:"operationKind,omitempty"`
	State         string      `json:"state,omitempty"`
	IssueState    IssueState  `json:"issueState,omitempty"`
	ReleaseID     string      `json:"releaseId,omitempty"`
	JourneyID     string      `json:"journeyId,omitempty"`
	TraceID       string      `json:"traceId,omitempty"`
	SpanID        string      `json:"spanId,omitempty"`
	RequestID     string      `json:"requestId,omitempty"`
	CommandID     string      `json:"commandId,omitempty"`
	ProviderID    string      `json:"providerId,omitempty"`
	FromCursor    *int64      `json:"fromCursor,omitempty"`
	ToCursor      *int64      `json:"toCursor,omitempty"`
	FromTime      time.Time   `json:"fromTime,omitempty"`
	ToTime        time.Time   `json:"toTime,omitempty"`
}

type TraceSpanLookupV1 struct {
	TraceID string `json:"traceId"`
	SpanID  string `json:"spanId"`
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

type AlternateSafeID struct {
	IDClass       string        `json:"idClass"`
	Value         string        `json:"value"`
	Storage       string        `json:"storage"`
	Copyable      bool          `json:"copyable"`
	HMACVersion   string        `json:"hmacVersion,omitempty"`
	UnknownReason UnknownReason `json:"unknownReason,omitempty"`
}

type AgentBriefGap struct {
	Kind        string `json:"kind"`
	Summary     string `json:"summary"`
	Reason      string `json:"reason"`
	FirstCursor *int64 `json:"firstCursor,omitempty"`
	LastCursor  *int64 `json:"lastCursor,omitempty"`
}

type AgentBriefV1 struct {
	SchemaVersion    string                      `json:"schemaVersion"`
	Version          int                         `json:"version"`
	Reference        string                      `json:"reference"`
	FocusedReference string                      `json:"focusedReference,omitempty"`
	CaptureTime      time.Time                   `json:"captureTime"`
	SelectedCursor   *int64                      `json:"selectedCursor,omitempty"`
	RunEndCursor     *int64                      `json:"runEndCursor,omitempty"`
	ObservedSummary  string                      `json:"observedSummary"`
	Environment      Environment                 `json:"environment"`
	ResolverCommand  string                      `json:"resolverCommand"`
	ReleaseCommits   []AgentBriefRelease         `json:"releaseCommits"`
	VisibleGaps      []AgentBriefGap             `json:"visibleGaps"`
	EpisodeSummary   string                      `json:"episodeSummary,omitempty"`
	Issues           []DiagnosticIssueDetail     `json:"issues,omitempty"`
	Operations       []DiagnosticOperationDetail `json:"operations,omitempty"`
	Branches         []DiagnosticBranchDetail    `json:"branches,omitempty"`
	Counts           map[string]int64            `json:"counts"`
	Omissions        []string                    `json:"omissions"`
}

type AgentBriefRelease struct {
	Release       string        `json:"release"`
	SourceCommit  string        `json:"sourceCommit,omitempty"`
	UnknownReason UnknownReason `json:"unknownReason,omitempty"`
}

type ExportJobState string

const (
	ExportQueued    ExportJobState = "queued"
	ExportRunning   ExportJobState = "running"
	ExportSucceeded ExportJobState = "succeeded"
	ExportFailed    ExportJobState = "failed"
	ExportCancelled ExportJobState = "cancelled"
	ExportExpired   ExportJobState = "expired"
)

type DiagnosticExportManifestV1 struct {
	SchemaVersion string            `json:"schemaVersion"`
	Reference     string            `json:"reference"`
	CursorFrom    int64             `json:"cursorFrom"`
	CursorTo      int64             `json:"cursorTo"`
	EventCount    int64             `json:"eventCount"`
	OmissionCount int64             `json:"omissionCount"`
	Checksums     map[string]string `json:"checksums"`
	Compressed    bool              `json:"compressed"`
	SplitParts    int               `json:"splitParts,omitempty"`
}

type ExportJobProgress struct {
	ProcessedEvents int64   `json:"processedEvents"`
	TotalEvents     int64   `json:"totalEvents,omitempty"`
	Percent         float64 `json:"percent,omitempty"`
	CurrentCursor   int64   `json:"currentCursor,omitempty"`
}

type DiagnosticExportJob struct {
	SchemaVersion     string                      `json:"schemaVersion"`
	JobID             string                      `json:"jobId"`
	Reference         string                      `json:"reference"`
	State             ExportJobState              `json:"state"`
	CreatedAt         time.Time                   `json:"createdAt"`
	LeaseEndsAt       time.Time                   `json:"leaseEndsAt"`
	DownloadExpiresAt *time.Time                  `json:"downloadExpiresAt,omitempty"`
	CursorFrom        int64                       `json:"cursorFrom"`
	CursorTo          int64                       `json:"cursorTo,omitempty"`
	Manifest          *DiagnosticExportManifestV1 `json:"manifest,omitempty"`
	ErrorReason       string                      `json:"errorReason,omitempty"`
	Progress          *ExportJobProgress          `json:"progress,omitempty"`
	CancelledAt       *time.Time                  `json:"cancelledAt,omitempty"`
	DownloadURL       string                      `json:"downloadUrl,omitempty"`
}

// DiagnosticExportStatus is the status shape returned by the API, including
// optional progress and download fields.
type DiagnosticExportStatus = DiagnosticExportJob
