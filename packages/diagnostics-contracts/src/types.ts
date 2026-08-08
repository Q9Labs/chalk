export const DIAGNOSTIC_CONTRACT_VERSION = 1 as const;

export type Environment = "localhost" | "development" | "staging" | "production";
export type DiagnosticEventSource = "ui" | "sdk" | "api" | "sync" | "rtc" | "provider" | "worker";
export type DiagnosticEventState = "started" | "observed" | "succeeded" | "failed" | "cancelled" | "timed_out" | "not_observable" | "late_observed";
export type CheckpointClass = "required" | "conditional" | "best_effort";
export type SafeUnknownReason = "not_retained" | "not_observable" | "redacted" | "provider_opaque" | "expired" | "not_available" | "invalid" | "diagnostics_disabled" | "permission_denied" | "unknown";

export type DiagnosticEventExpectation = Readonly<{
  name: string;
  version: number;
  checkpoint: string;
  checkpointClass: CheckpointClass;
  deadlineAt?: string;
}>;

export type DiagnosticEventCorrelation = Readonly<{
  journeyId?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  commandId?: string;
  providerId?: string;
  retryGroupRef?: string;
  attempt?: number;
}>;

export type DiagnosticRelease = Readonly<{
  id: string;
  sourceCommit?: string;
}>;

export type DiagnosticAttributes = Readonly<Record<string, boolean | number | string>>;

export type DiagnosticEventDraft = Readonly<{
  version: 1;
  eventId: string;
  producerOperationRef?: string;
  parentProducerOperationRef?: string;
  producerSequence: number;
  occurredAt: string;
  source: DiagnosticEventSource;
  name: string;
  phase: string;
  state: DiagnosticEventState;
  expectation?: DiagnosticEventExpectation;
  correlation?: DiagnosticEventCorrelation;
  release?: DiagnosticRelease;
  attributes?: DiagnosticAttributes;
}>;

export type AcceptedDiagnosticEvent = DiagnosticEventDraft &
  Readonly<{
    diagnosticId: string;
    cursor: number;
    receivedAt: string;
    fingerprint: string;
  }>;

export type DiagnosticEvent = DiagnosticEventDraft;
export type DiagnosticAcceptedEvent = AcceptedDiagnosticEvent;
export type AcceptedEvent = AcceptedDiagnosticEvent;

export type OperationState = "running" | "retrying" | "succeeded" | "failed" | "stalled" | "cancelled" | "timed_out";
export type CheckpointState = "pending" | "observed" | "missed" | "not_observable" | "late_observed";

export type DiagnosticCheckpointDetail = Readonly<{
  key: string;
  class: CheckpointClass;
  displayOrder: number;
  state: CheckpointState;
  deadlineAt?: string;
  evidenceCursor?: number;
  unknownReason?: SafeUnknownReason;
  predicate?: string;
}>;
export type CheckpointDetailV1 = DiagnosticCheckpointDetail;

export type SafeIdentifier = Readonly<{
  idClass: string;
  value?: string;
  unknownReason?: SafeUnknownReason;
  copyable: boolean;
}>;

export type DiagnosticAffectedSubject = Readonly<{
  kind: "participant" | "service";
  identifier: SafeIdentifier;
}>;

export type DiagnosticOperationDetail = Readonly<{
  schemaVersion?: "OperationDetail/v1";
  id: string;
  reference?: string;
  diagnosticReference?: string;
  parentId?: string;
  branchId?: string;
  kind: string;
  expectationVersion: number;
  state: OperationState;
  attempt: number;
  retryGroup?: SafeIdentifier | string;
  startedAt: string;
  deadlineAt?: string;
  graceEndsAt?: string;
  endedAt?: string;
  durationMilliseconds?: number;
  checkpoints: readonly DiagnosticCheckpointDetail[];
  errorClass?: string;
  requestId?: SafeIdentifier | string;
  commandId?: SafeIdentifier | string;
  providerId?: SafeIdentifier | string;
  journeyId?: SafeIdentifier | string;
  traceId?: SafeIdentifier | string;
  spanId?: SafeIdentifier | string;
  source: DiagnosticEventSource;
  releaseId?: string;
  sourceCommit?: string;
  clockUncertainty?: string;
  visibilityGaps?: readonly string[];
}>;
export type OperationDetailV1 = DiagnosticOperationDetail;

export type IssueSeverity = "info" | "warning" | "error" | "critical";
export type IssueState = "open" | "resolved";
export type DiagnosticIssueDetail = Readonly<{
  schemaVersion?: "IssueDetail/v1";
  id: string;
  reference?: string;
  diagnosticReference?: string;
  operationId?: string;
  affected?: DiagnosticAffectedSubject;
  kind: string;
  severity: IssueSeverity;
  state: IssueState;
  summary: string;
  firstObservedAt: string;
  lastObservedAt?: string;
  resolvedAt?: string;
  lastConfirmedCheckpoint?: string;
  missingCheckpoint?: string;
  retryState?: string;
  unknownReason?: SafeUnknownReason;
}>;
export type IssueDetailV1 = DiagnosticIssueDetail;

export type BranchKind = "cleanup" | "recording" | "transcription" | "artifact" | "webhook";
export type BranchState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type DiagnosticBranchDetail = Readonly<{
  schemaVersion?: "BranchDetail/v1";
  id: string;
  reference?: string;
  kind: BranchKind;
  state: BranchState;
  leaseEndsAt: string;
  startedAt?: string;
  terminalAt?: string;
  terminalCursor?: number;
  attempts: number;
  fanInChildren?: readonly string[];
  lateObservations?: number;
  unknownReason?: SafeUnknownReason;
}>;
export type BranchDetailV1 = DiagnosticBranchDetail;

export type DiagnosticSummary = Readonly<{
  eventCount: number;
  operationCount: number;
  issueCount: number;
  openIssueCount: number;
  participantCount?: number;
}>;

export type DisplayValue<T> = Readonly<{
  value?: T;
  unknownReason?: SafeUnknownReason;
}>;

export type ParticipantProjectionV1 = Readonly<{
  schemaVersion: "ParticipantProjection/v1";
  participantId: string;
  anonymousLabel: string;
  identityKind: "user" | "agent" | "guest" | "unknown";
  state: "joined" | "reconnecting" | "left" | "unknown";
  joinedAt?: string;
  leftAt?: string;
  visibility: "observable" | "not_observable" | "disconnected";
  visibilityGaps: readonly string[];
  operationCount: number;
  issueCount: number;
  display: Readonly<{
    label: DisplayValue<string>;
    rawIdentity: DisplayValue<string>;
  }>;
}>;

export type RunProjectionV1 = Readonly<{
  schemaVersion: "RunProjection/v1";
  state: "live" | "ended" | "complete" | "expired";
  startedAt: string;
  endedAt?: string;
  elapsedMilliseconds: number;
  participantCount: number;
  activeOperationCount: number;
  openIssueCount: number;
  latestConfirmedBoundary?: DisplayValue<string>;
  firstMissingBoundary?: DisplayValue<string>;
  participantLanes: readonly Readonly<{ participantId: string; operationIds: readonly string[]; state: string }>[];
}>;

export type GraphNodeKind = "ui" | "sdk" | "access" | "api" | "sync" | "database" | "media" | "sfu" | "worker" | "provider" | "unknown";
export type GraphProjectionV1 = Readonly<{
  schemaVersion: "GraphProjection/v1";
  nodes: readonly Readonly<{ id: string; kind: GraphNodeKind; label: string; state: "healthy" | "active" | "stalled" | "failed" | "unobservable" | "unknown"; operationCount: number; issueCount: number }>[];
  edges: readonly Readonly<{ id: string; from: string; to: string; state: "healthy" | "active" | "stalled" | "failed" | "unobservable" | "unknown"; operationIds: readonly string[]; issueIds: readonly string[] }>[];
  summary: Readonly<{ nodeCount: number; edgeCount: number; activeCount: number; failedCount: number; unobservableCount: number }>;
}>;

export type FlameProjectionV1 = Readonly<{
  schemaVersion: "FlameProjection/v1";
  lanes: readonly Readonly<{ id: string; label: string; source: DiagnosticEventSource; bars: readonly Readonly<{ id: string; operationId?: string; startAt: string; endAt?: string; state: OperationState; attempt?: number; retryGroup?: string }>[] }>[];
  buckets: readonly Readonly<{ startAt: string; endAt: string; count: number; failedCount: number; heat: number }>[];
  heat: readonly Readonly<{ laneId: string; startAt: string; endAt: string; intensity: number }>[];
}>;

export type EpilogueProjectionV1 = Readonly<{
  schemaVersion: "EpilogueProjection/v1";
  state: "pending" | "live" | "complete" | "expired";
  completedAt?: string;
  branches: readonly DiagnosticBranchDetail[];
  openBranchCount: number;
  terminalBranchCount: number;
  latestTerminalCursor?: number;
}>;

export type DiagnosticSnapshotV1 = Readonly<{
  schemaVersion: "DiagnosticSnapshot/v1";
  reference: string;
  environment: Environment;
  state: "live" | "ended" | "complete" | "expired";
  capturedAt: string;
  committedCursor: number;
  projectedCursor: number;
  filterFingerprint: string;
  runEndCursor?: number;
  summary: DiagnosticSummary;
  operations: readonly DiagnosticOperationDetail[];
  issues: readonly DiagnosticIssueDetail[];
  branches: readonly DiagnosticBranchDetail[];
  participants?: readonly ParticipantProjectionV1[];
  run?: RunProjectionV1;
  graph?: GraphProjectionV1;
  flame?: FlameProjectionV1;
  epilogue?: EpilogueProjectionV1;
  omissions?: readonly string[];
}>;
export type DiagnosticSnapshot = DiagnosticSnapshotV1;

export type DiagnosticEventPageV1 = Readonly<{
  schemaVersion: "DiagnosticEventPage/v1";
  reference: string;
  events: readonly AcceptedDiagnosticEvent[];
  committedCursor: number;
  projectedCursor: number;
  afterCursor?: number;
  beforeCursor?: number;
  nextCursor?: number;
  hasMore: boolean;
  filterFingerprint: string;
}>;
export type DiagnosticEventPage = DiagnosticEventPageV1;

export type DiagnosticOperationPageV1 = Readonly<{
  schemaVersion: "DiagnosticOperationPage/v1";
  reference: string;
  operations: readonly DiagnosticOperationDetail[];
  committedCursor: number;
  projectedCursor: number;
  nextCursor?: number;
  hasMore: boolean;
  filterFingerprint: string;
}>;
export type DiagnosticOperationPage = DiagnosticOperationPageV1;

export type DiagnosticStreamDeltaKind = "event_appended" | "operation_updated" | "issue_updated" | "branch_updated" | "snapshot" | "gap";
export type DiagnosticStreamDeltaV1 = Readonly<{
  schemaVersion: "DiagnosticStreamDelta/v1";
  reference: string;
  cursor: number;
  kind: DiagnosticStreamDeltaKind;
  filterFingerprint: string;
  event?: AcceptedDiagnosticEvent;
  operation?: DiagnosticOperationDetail;
  issue?: DiagnosticIssueDetail;
  branch?: DiagnosticBranchDetail;
  snapshot?: DiagnosticSnapshotV1;
  gap?: Readonly<{ fromCursor: number; toCursor: number; reason: SafeUnknownReason | string }>;
}>;
export type DiagnosticSseDeltaV1 = DiagnosticStreamDeltaV1;
export type DiagnosticStreamDelta = DiagnosticStreamDeltaV1;

export type DiagnosticStreamControlV1 = Readonly<{
  schemaVersion: "DiagnosticStreamControl/v1";
  heartbeatIntervalSeconds: number;
  maxConnectionSeconds: number;
  afterCursor: number;
  filterFingerprint: string;
  maxPendingDeltas: number;
}>;
export type DiagnosticStreamCloseV1 = Readonly<{
  schemaVersion: "DiagnosticStreamClose/v1";
  reason: "slow_consumer" | "expired" | "unauthorized" | "server_shutdown" | "filter_mismatch" | "client_disconnected" | "deadline" | "server_error";
  resumableCursor: number;
  refillRequired: boolean;
}>;
export type DiagnosticStreamStatusV1 = Readonly<{
  schemaVersion: "DiagnosticStreamStatus/v1";
  connected: boolean;
  lastCursor: number;
  committedCursor: number;
  projectedCursor: number;
  projectorLagMilliseconds: number;
  gapRefillRequired: boolean;
}>;

export type DiagnosticFilterV1 = Readonly<{
  schemaVersion: "DiagnosticFilter/v1";
  participantId?: string;
  source?: DiagnosticEventSource;
  operationKind?: string;
  state?: string;
  issueState?: IssueState;
  releaseId?: string;
  journeyId?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  commandId?: string;
  providerId?: string;
  fromCursor?: number;
  toCursor?: number;
  fromTime?: string;
  toTime?: string;
}>;
export type TraceSpanLookupV1 = Readonly<{ traceId: string; spanId: string }>;
export type DiagnosticResolverResponseV1 =
  | Readonly<{ kind: "diagnostic"; reference: string; snapshot: DiagnosticSnapshotV1 }>
  | Readonly<{ kind: "operation"; reference: string; snapshot: DiagnosticSnapshotV1; operation: DiagnosticOperationDetail }>
  | Readonly<{ kind: "issue"; reference: string; snapshot: DiagnosticSnapshotV1; issue: DiagnosticIssueDetail }>
  | Readonly<{ kind: "event"; reference: string; snapshot: DiagnosticSnapshotV1; event: AcceptedDiagnosticEvent }>
  | Readonly<{ kind: "not_found"; reference?: string; reason: SafeUnknownReason | string }>;

export type AgentBriefQueryV1 = Readonly<{
  schemaVersion: "AgentBriefQuery/v1";
  reference: string;
  cursor?: number;
  format: "compact" | "markdown";
  aroundSeconds?: number;
  branchId?: string;
}>;
export type AgentBriefResponseV1 = Readonly<{
  schemaVersion: "AgentBriefResponse/v1";
  format: "compact" | "markdown";
  brief: AgentBriefV1;
  markdown?: string;
}>;

export type DiagnosticReferenceFocusKind = "op" | "issue" | "event";
export type DiagnosticReference = Readonly<{
  version: 1;
  environment: Environment;
  diagnosticId: string;
  focus?: Readonly<{ kind: DiagnosticReferenceFocusKind; id: string }>;
  cursor?: number;
}>;

export type AlternateSafeId = Readonly<{
  idClass: string;
  value: string;
  storage: "raw" | "hmac";
  copyable: boolean;
  hmacVersion?: string;
  unknownReason?: SafeUnknownReason;
}>;

export type AgentBriefGap = Readonly<{
  kind: string;
  summary: string;
  reason: SafeUnknownReason | string;
  firstCursor?: number;
  lastCursor?: number;
}>;
export type AgentBriefV1 = Readonly<{
  schemaVersion: "AgentBrief/v1";
  version: 1;
  reference: string;
  focusedReference?: string;
  captureTime: string;
  selectedCursor?: number;
  runEndCursor?: number;
  observedSummary: string;
  environment: Environment;
  resolverCommand: string;
  releaseCommits: readonly Readonly<{ release: string; sourceCommit?: string; unknownReason?: SafeUnknownReason }>[];
  visibleGaps: readonly AgentBriefGap[];
  episodeSummary?: string;
  issues?: readonly DiagnosticIssueDetail[];
  operations?: readonly DiagnosticOperationDetail[];
  branches?: readonly DiagnosticBranchDetail[];
  counts: Readonly<Record<string, number>>;
  omissions: readonly string[];
}>;

export type ExportJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
export type DiagnosticExportManifestV1 = Readonly<{
  schemaVersion: "DiagnosticBundle/v1";
  reference: string;
  cursorFrom: number;
  cursorTo: number;
  eventCount: number;
  omissionCount: number;
  checksums: Readonly<Record<string, string>>;
  compressed: boolean;
  splitParts?: number;
}>;
export type DiagnosticExportJob = Readonly<{
  schemaVersion: "ExportJob/v1";
  jobId: string;
  reference: string;
  state: ExportJobState;
  createdAt: string;
  leaseEndsAt: string;
  downloadExpiresAt?: string;
  cursorFrom: number;
  cursorTo?: number;
  manifest?: DiagnosticExportManifestV1;
  errorReason?: SafeUnknownReason | string;
}>;
export type ExportJobV1 = DiagnosticExportJob;

export type ActionCheckpointContract = Readonly<{
  key: string;
  class: CheckpointClass;
  displayOrder: number;
  predicate?: string;
}>;
export type ActionContractV1 = Readonly<{
  version: 1;
  group: string;
  root: string;
  action: string;
  operation: string;
  owner: string;
  proofId: string;
  expectationVersion: number;
  checkpoints: readonly ActionCheckpointContract[];
  expectationFixture: string;
  successFixture: string;
  failureFixture: string;
  unsupported?: boolean;
}>;
export type DiagnosticActionStatus = "supported" | "unsupported" | "unclassified";
