export type DiagnosticEventSource = "ui" | "sdk" | "api" | "sync" | "rtc" | "provider" | "worker";
export type DiagnosticEventState = "started" | "observed" | "succeeded" | "failed" | "cancelled" | "timed_out" | "not_observable" | "late_observed";
export type CheckpointClass = "required" | "conditional" | "best_effort";

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
