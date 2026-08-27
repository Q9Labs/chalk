import { ACTION_SET_V1 } from "./actions.js";
import { parseDiagnosticEventDraft } from "./events.js";
import type { ActionCheckpointContract, ActionContractV1, CheckpointClass, DiagnosticEventDraft } from "./types.js";

const SEMANTIC_FIXTURE_BASE_TIME = "2026-08-04T00:00:00.000Z";
const SEMANTIC_FIXTURE_SOURCE = "semantic-fixtures.v1";

export type SemanticFixtureVariant = "expectation" | "success" | "failure_or_gap";

export type SemanticFixtureCheckpoint = Readonly<
  ActionCheckpointContract & {
    deadlineAt: string;
    deadlineMilliseconds: number;
  }
>;

export type SemanticActionFixture = Readonly<{
  schemaVersion: "EpisodeDiagnosticFixture/v1";
  fixtureId: string;
  operation: string;
  variant: SemanticFixtureVariant;
  owner: string;
  proofId: string;
  expectationVersion: number;
  unsupported?: true;
  checkpoints: readonly SemanticFixtureCheckpoint[];
  events: readonly DiagnosticEventDraft[];
}>;

export type SemanticFixtureSet = Readonly<{
  schemaVersion: "EpisodeDiagnosticFixtureSet/v1";
  generatedFrom: "episode-diagnostic-actions.v1.json";
  generatedBy: typeof SEMANTIC_FIXTURE_SOURCE;
  baseTime: typeof SEMANTIC_FIXTURE_BASE_TIME;
  contentCaptured: false;
  fixtures: Readonly<Record<string, SemanticActionFixture>>;
}>;

export type VerificationLedgerEntry = Readonly<{
  operation: string;
  owner: string;
  proofId: string;
  status: "pending" | "pass";
  fixtureStatus: "pass";
  runtimeStatus: "pending" | "pass";
  proofCommand: string;
  proofArtifact: string;
  unsupported?: true;
  fixturePaths: Readonly<{
    expectation: string;
    success: string;
    failure: string;
  }>;
}>;

export type VerificationLedger = Readonly<{
  schemaVersion: "EpisodeDiagnosticVerificationLedger/v1";
  generatedFrom: "episode-diagnostic-actions.v1.json";
  generatedBy: typeof SEMANTIC_FIXTURE_SOURCE;
  status: "pending";
  fixtureStatus: "pass";
  runtimeStatus: "pending";
  entries: readonly VerificationLedgerEntry[];
}>;

// The action catalog is the only semantic authority. This list is only a
// coverage sentinel for predicates that must never regress to intent/terminal.
export const HIGH_RISK_OPERATIONS = [
  "chat.send",
  "chat.retry",
  "chat.page",
  "chat.read",
  "chat.attachment.prepare",
  "chat.attachment.commit",
  "chat.attachment.fail",
  "reaction.send",
  "reaction.dedupe",
  "reaction.expire",
  "screen.start",
  "screen.stop",
  "screen.unexpected_end",
  "screen.recover",
  "moderation.role.change",
  "moderation.capability.check",
  "moderation.microphone.disable",
  "moderation.camera.disable",
  "moderation.screen.disable",
  "moderation.remove",
  "moderation.ban",
] as const;

const REQUIRED_DEADLINE_MS = 2_000;
const CONDITIONAL_DEADLINE_MS = 5_000;
const BEST_EFFORT_DEADLINE_MS = 10_000;
const CHECKPOINT_STEP_MS = 1_000;
const FAILURE_AFTER_DEADLINE_MS = 250;
const SUCCESS_BEFORE_DEADLINE_MS = 250;

const SOURCE_BY_ROOT: Readonly<Record<string, DiagnosticEventDraft["source"]>> = {
  whiteboard: "ui",
  sync: "sync",
  recording: "worker",
  transcription: "worker",
  cleanup: "worker",
  artifact: "worker",
  webhook: "worker",
  episode: "api",
  access: "api",
  admission: "api",
  moderation: "api",
};

const PROVIDER_CALLBACK_OPERATIONS = new Set(["recording.provider.callback", "transcription.provider.callback"]);

const sourceForAction = (action: ActionContractV1): DiagnosticEventDraft["source"] => (PROVIDER_CALLBACK_OPERATIONS.has(action.operation) ? "provider" : (SOURCE_BY_ROOT[action.root] ?? "sdk"));

const checkpointDeadlineBase = (checkpointClass: CheckpointClass): number => {
  if (checkpointClass === "conditional") return CONDITIONAL_DEADLINE_MS;
  if (checkpointClass === "best_effort") return BEST_EFFORT_DEADLINE_MS;
  return REQUIRED_DEADLINE_MS;
};

const fixtureIdFor = (operation: string, variant: SemanticFixtureVariant): string => `${variant === "failure_or_gap" ? "failure" : variant}.${operation}.v1`;

const expectationNameFor = (operation: string): string => `expectation.${operation}.v1`;

const operationStart = (actionIndex: number): Date => new Date(Date.parse(SEMANTIC_FIXTURE_BASE_TIME) + actionIndex * 60_000);

const isoAt = (start: Date, milliseconds: number): string => new Date(start.getTime() + milliseconds).toISOString();

const toCheckpoints = (action: ActionContractV1, start: Date): readonly SemanticFixtureCheckpoint[] => {
  return action.checkpoints.map((checkpoint) => {
    const deadlineMilliseconds = checkpointDeadlineBase(checkpoint.class) + checkpoint.displayOrder * CHECKPOINT_STEP_MS;
    return {
      ...checkpoint,
      deadlineAt: isoAt(start, deadlineMilliseconds),
      deadlineMilliseconds,
    };
  });
};

const FAILURE_PHASES: Readonly<Record<string, string>> = {
  permission: "denied",
  capability_decision: "denied",
  authorization: "denied",
};

const SUCCESS_PHASES: Readonly<Record<string, string>> = {
  validation: "validation",
  authorization: "authorized",
  capability_decision: "authorized",
  permission: "authorized",
  durable_commit: "committed",
  accepted_commit: "committed",
  command_commit: "committed",
  sync_commit: "committed",
  storage_commit: "committed",
  sender_receipt: "receipt",
  sender_result: "receipt",
  paging_visibility: "paged",
  page_visibility: "paged",
  recipient_projection: "projected",
  remote_first_frame: "first_frame",
  target_delivery: "delivered",
  target_application: "observed",
  dedupe_key_outcome: "deduped",
  server_expiry: "expired",
  track_end: "observed",
  stop_confirmation: "observed",
  recovery_terminal: "succeeded",
};

const PHASE_RESOLVERS: Readonly<Record<SemanticFixtureVariant, (checkpoint: string) => string>> = {
  expectation: () => "intent",
  success: (checkpoint) => SUCCESS_PHASES[checkpoint] ?? "succeeded",
  failure_or_gap: (checkpoint) => FAILURE_PHASES[checkpoint] ?? "failed",
};

const phaseForCheckpoint = (checkpoint: string, variant: SemanticFixtureVariant, unsupported: boolean): string => {
  if (unsupported) return "unsupported";
  return PHASE_RESOLVERS[variant](checkpoint);
};

const firstRequiredCheckpoint = (checkpoints: readonly SemanticFixtureCheckpoint[]): SemanticFixtureCheckpoint => {
  const checkpoint = checkpoints.find((candidate) => candidate.class === "required");
  return checkpoint ?? checkpoints[0] ?? { key: "terminal", class: "required", displayOrder: 0, deadlineAt: SEMANTIC_FIXTURE_BASE_TIME, deadlineMilliseconds: REQUIRED_DEADLINE_MS };
};

const CHECKPOINT_GAP_CLASSES: Readonly<Partial<Record<SemanticFixtureVariant, CheckpointClass>>> = { failure_or_gap: "conditional" };

const isConditionalGap = (variant: SemanticFixtureVariant, checkpoint: SemanticFixtureCheckpoint): boolean => CHECKPOINT_GAP_CLASSES[variant] === checkpoint.class;

type SemanticEventStatus = "expected" | "unsupported" | "succeeded" | "gap" | "failed";
type EventTimestampResolver = (start: Date, deadlineMilliseconds: number) => string;

const OCCURRED_AT_RESOLVERS: Readonly<Record<SemanticFixtureVariant, EventTimestampResolver>> = {
  expectation: (start) => start.toISOString(),
  success: (start, deadlineMilliseconds) => isoAt(start, Math.max(0, deadlineMilliseconds - SUCCESS_BEFORE_DEADLINE_MS)),
  failure_or_gap: (start, deadlineMilliseconds) => isoAt(start, deadlineMilliseconds + FAILURE_AFTER_DEADLINE_MS),
};

const STATE_BY_VARIANT: Readonly<Record<SemanticFixtureVariant, DiagnosticEventDraft["state"]>> = {
  expectation: "started",
  success: "succeeded",
  failure_or_gap: "failed",
};

const STATUS_BY_VARIANT: Readonly<Record<SemanticFixtureVariant, SemanticEventStatus>> = {
  expectation: "expected",
  success: "succeeded",
  failure_or_gap: "failed",
};

const stateForEvent = (variant: SemanticFixtureVariant, unsupported: boolean, isGap: boolean): DiagnosticEventDraft["state"] => {
  if (variant === "expectation") return STATE_BY_VARIANT[variant];
  if (unsupported) return "not_observable";
  return isGap ? "not_observable" : STATE_BY_VARIANT[variant];
};

const statusForEvent = (variant: SemanticFixtureVariant, unsupported: boolean, isGap: boolean): SemanticEventStatus => {
  if (variant === "expectation") return STATUS_BY_VARIANT[variant];
  if (unsupported) return "unsupported";
  return isGap ? "gap" : STATUS_BY_VARIANT[variant];
};

const reasonForEvent = (variant: SemanticFixtureVariant, unsupported: boolean, isGap: boolean): string | undefined => {
  if (unsupported) return "unsupported";
  if (variant !== "failure_or_gap") return undefined;
  return isGap ? "visibility_gap" : "checkpoint_deadline";
};

const attributesForEvent = (action: ActionContractV1, variant: SemanticFixtureVariant, checkpoint: SemanticFixtureCheckpoint, unsupported: boolean, isGap: boolean): Record<string, boolean | number | string> => {
  const reason = reasonForEvent(variant, unsupported, isGap);
  return {
    action: action.operation,
    checkpoint: checkpoint.key,
    status: statusForEvent(variant, unsupported, isGap),
    deadline_ms: checkpoint.deadlineMilliseconds,
    attempt: variant === "failure_or_gap" ? 1 : 0,
    ...(reason === undefined ? {} : { reason }),
    ...(isGap ? { visibility: "not_observable" } : {}),
  };
};

const COMMAND_CORRELATION_ROOTS = new Set(["moderation", "admission", "media_request"]);

const correlationForEvent = (action: ActionContractV1, actionIndex: number, variant: SemanticFixtureVariant, sequence: number): DiagnosticEventDraft["correlation"] => ({
  journeyId: `journey.fixture.${actionIndex}`,
  traceId: `trace.fixture.${actionIndex}`,
  spanId: `span.fixture.${variant}.${sequence}`,
  requestId: `request.fixture.${actionIndex}`,
  ...(COMMAND_CORRELATION_ROOTS.has(action.root) ? { commandId: `command.fixture.${actionIndex}` } : {}),
  attempt: variant === "failure_or_gap" ? 1 : 0,
});

const makeEvent = (action: ActionContractV1, actionIndex: number, start: Date, variant: SemanticFixtureVariant, checkpoint: SemanticFixtureCheckpoint, sequence: number): DiagnosticEventDraft => {
  const unsupported = action.unsupported === true;
  const isGap = isConditionalGap(variant, checkpoint);
  return {
    version: 1,
    eventId: `fixture.${action.operation}.${variant}.${sequence}`,
    producerOperationRef: `fixture.operation.${action.operation}.${variant}`,
    producerSequence: sequence,
    occurredAt: OCCURRED_AT_RESOLVERS[variant](start, checkpoint.deadlineMilliseconds),
    source: sourceForAction(action),
    name: action.operation,
    phase: phaseForCheckpoint(checkpoint.key, variant, unsupported),
    state: stateForEvent(variant, unsupported, isGap),
    expectation: {
      name: expectationNameFor(action.operation),
      version: action.expectationVersion,
      checkpoint: checkpoint.key,
      checkpointClass: checkpoint.class,
      deadlineAt: checkpoint.deadlineAt,
    },
    correlation: correlationForEvent(action, actionIndex, variant, sequence),
    release: { id: "fixture-release-v1", sourceCommit: "fixture-commit-v1" },
    attributes: attributesForEvent(action, variant, checkpoint, unsupported, isGap),
  };
};

const makeFixture = (action: ActionContractV1, actionIndex: number, variant: SemanticFixtureVariant): SemanticActionFixture => {
  const start = operationStart(actionIndex);
  const checkpoints = toCheckpoints(action, start);
  const unsupported = action.unsupported === true;
  const selected = variant === "failure_or_gap" ? [firstRequiredCheckpoint(checkpoints), ...checkpoints.filter((checkpoint) => checkpoint.class === "conditional")] : checkpoints;
  const events = selected.map((checkpoint, index) => parseDiagnosticEventDraft(makeEvent(action, actionIndex, start, variant, checkpoint, index)));
  const fixtureId = fixtureIdFor(action.operation, variant);
  return {
    schemaVersion: "EpisodeDiagnosticFixture/v1",
    fixtureId,
    operation: action.operation,
    variant,
    owner: action.owner,
    proofId: action.proofId,
    expectationVersion: action.expectationVersion,
    ...(unsupported ? { unsupported: true as const } : {}),
    checkpoints,
    events,
  };
};

export const buildSemanticFixtureSet = (actions: readonly ActionContractV1[] = ACTION_SET_V1): SemanticFixtureSet => {
  const fixtures: Record<string, SemanticActionFixture> = {};
  actions.forEach((action, index) => {
    for (const variant of ["expectation", "success", "failure_or_gap"] as const) {
      const fixture = makeFixture(action, index, variant);
      if (fixtures[fixture.fixtureId] !== undefined) throw new Error(`duplicate semantic fixture ID: ${fixture.fixtureId}`);
      fixtures[fixture.fixtureId] = fixture;
    }
  });
  return {
    schemaVersion: "EpisodeDiagnosticFixtureSet/v1",
    generatedFrom: "episode-diagnostic-actions.v1.json",
    generatedBy: SEMANTIC_FIXTURE_SOURCE,
    baseTime: SEMANTIC_FIXTURE_BASE_TIME,
    contentCaptured: false,
    fixtures,
  };
};

export const buildVerificationLedger = (actions: readonly ActionContractV1[] = ACTION_SET_V1): VerificationLedger => ({
  schemaVersion: "EpisodeDiagnosticVerificationLedger/v1",
  generatedFrom: "episode-diagnostic-actions.v1.json",
  generatedBy: SEMANTIC_FIXTURE_SOURCE,
  status: "pending",
  fixtureStatus: "pass",
  runtimeStatus: "pending",
  entries: actions.map((action) => ({
    operation: action.operation,
    owner: action.owner,
    proofId: action.proofId,
    status: "pending" as const,
    fixtureStatus: "pass" as const,
    runtimeStatus: "pending" as const,
    proofCommand: "" as const,
    proofArtifact: "" as const,
    ...(action.unsupported ? { unsupported: true as const } : {}),
    fixturePaths: {
      expectation: `fixtures/semantic-events.v1.json#/fixtures/${action.expectationFixture}`,
      success: `fixtures/semantic-events.v1.json#/fixtures/${action.successFixture}`,
      failure: `fixtures/semantic-events.v1.json#/fixtures/${action.failureFixture}`,
    },
  })),
});

export const isRuntimeProofComplete = (entry: Pick<VerificationLedgerEntry, "runtimeStatus" | "proofCommand" | "proofArtifact">): boolean => entry.runtimeStatus === "pass" && entry.proofCommand.length > 0 && entry.proofArtifact.length > 0;
