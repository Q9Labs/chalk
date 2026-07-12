import { canonicalJsonBytes } from "./canonical";
import type { CanonicalJson } from "./canonical";
import { SyncProtocolLimits } from "../generated/sync-v2";
import type { CanonicalReplica, RecoveryCompleteFrame, ReplayPageFrame, SyncHead, WelcomeFrame } from "./types";

export const RECOVERY_LIMITS = {
  maxReplayEvents: SyncProtocolLimits.completeReplayMaxEvents,
  maxReplayBytes: SyncProtocolLimits.completeReplayEncodedBytes,
  maxReplayPageEvents: SyncProtocolLimits.replayPageMaxEvents,
  maxReplayPageBytes: SyncProtocolLimits.replayPageEncodedBytes,
  maxSnapshotBytes: SyncProtocolLimits.snapshotEncodedBytes,
} as const;

export const MAX_INBOUND_SERVER_FRAME_BYTES = SyncProtocolLimits.snapshotEncodedBytes;

export type RecoveryPlan = {
  readonly recoveryId: string;
  readonly mode: "snapshot" | "replay" | "up_to_date";
  readonly head: SyncHead;
  readonly nextRevision: number;
  readonly replayEventCount: number;
  readonly replayBytes: number;
};

export class RecoveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryValidationError";
  }
}

export function beginRecovery(frame: WelcomeFrame, replica: CanonicalReplica | null): RecoveryPlan {
  assertHead(frame.head);
  if (frame.mode === "terminal") {
    throw new RecoveryValidationError("terminal welcome has no active recovery plan");
  }
  return recoveryPlans[frame.mode](frame, replica);
}

export function acceptReplayPage(plan: RecoveryPlan, page: ReplayPageFrame): RecoveryPlan {
  assertReplayPage(plan, page);
  const pageBytes = encodedBytes(page);
  assertReplayPageByteSize(pageBytes);
  const replayEventCount = plan.replayEventCount + page.events.length;
  const replayBytes = plan.replayBytes + encodedEventBytes(page.events);
  assertCompleteReplaySize(replayEventCount, replayBytes);
  return { ...plan, nextRevision: page.lastRevision + 1, replayEventCount, replayBytes };
}

export function completeRecovery(plan: RecoveryPlan, frame: RecoveryCompleteFrame, replica: CanonicalReplica): void {
  assertRecoveryCompletionMatches(plan, frame);
  assertRecoveredHead(plan, replica);
}

function assertRecoveryCompletionMatches(plan: RecoveryPlan, frame: RecoveryCompleteFrame): void {
  if (frame.recoveryId !== plan.recoveryId) {
    throw new RecoveryValidationError("recovery completion does not match its welcome");
  }
  if (!sameHead(frame.head, plan.head)) {
    throw new RecoveryValidationError("recovery completion does not match its welcome");
  }
}

function assertRecoveredHead(plan: RecoveryPlan, replica: CanonicalReplica): void {
  if (plan.nextRevision !== plan.head.revision + 1) {
    throw new RecoveryValidationError("recovery completed before reaching the authoritative head");
  }
  if (!sameHead(replica, plan.head)) {
    throw new RecoveryValidationError("recovery completed before reaching the authoritative head");
  }
}

type ActiveRecoveryMode = Exclude<WelcomeFrame["mode"], "terminal">;
type RecoveryPlanBuilder = (frame: WelcomeFrame, replica: CanonicalReplica | null) => RecoveryPlan;

const recoveryPlans: Record<ActiveRecoveryMode, RecoveryPlanBuilder> = {
  snapshot: snapshotRecovery,
  replay: replayRecovery,
  up_to_date: upToDateRecovery,
};

function snapshotRecovery(frame: WelcomeFrame): RecoveryPlan {
  const snapshot = frame.snapshot;
  if (!snapshot) {
    throw new RecoveryValidationError("snapshot welcome is missing its snapshot");
  }
  if (!sameHead(snapshot, frame.head)) {
    throw new RecoveryValidationError("snapshot metadata does not match the recovery head");
  }
  if (encodedBytes(snapshot.state) > RECOVERY_LIMITS.maxSnapshotBytes) {
    throw new RecoveryValidationError("snapshot exceeds the maximum encoded size");
  }
  return recoveryPlan(frame, frame.head.revision + 1);
}

function upToDateRecovery(frame: WelcomeFrame, replica: CanonicalReplica | null): RecoveryPlan {
  if (!replica) {
    throw new RecoveryValidationError("up-to-date recovery requires an identical local head");
  }
  if (!sameHead(replica, frame.head)) {
    throw new RecoveryValidationError("up-to-date recovery requires an identical local head");
  }
  return recoveryPlan(frame, frame.head.revision + 1);
}

function replayRecovery(frame: WelcomeFrame, replica: CanonicalReplica | null): RecoveryPlan {
  if (!replica) {
    throw new RecoveryValidationError("replay recovery requires a local replica");
  }
  if (replica.revision >= frame.head.revision) {
    throw new RecoveryValidationError("replay recovery requires an older local revision");
  }
  return recoveryPlan(frame, replica.revision + 1);
}

function recoveryPlan(frame: WelcomeFrame, nextRevision: number): RecoveryPlan {
  return { recoveryId: frame.recoveryId, mode: frame.mode as ActiveRecoveryMode, head: frame.head, nextRevision, replayEventCount: 0, replayBytes: 0 };
}

function assertReplayPage(plan: RecoveryPlan, page: ReplayPageFrame): void {
  if (plan.mode !== "replay") {
    throw new RecoveryValidationError("received a replay page outside replay recovery");
  }
  if (page.recoveryId !== plan.recoveryId) {
    throw new RecoveryValidationError("replay page belongs to a different recovery");
  }
  assertReplayPageLength(page);
  assertReplayRange(plan, page);
  assertReplayEvents(page);
}

function assertReplayPageLength(page: ReplayPageFrame): void {
  if (page.events.length === 0) {
    throw new RecoveryValidationError("replay page has an invalid event count");
  }
  if (page.events.length > RECOVERY_LIMITS.maxReplayPageEvents) {
    throw new RecoveryValidationError("replay page has an invalid event count");
  }
}

function assertReplayRange(plan: RecoveryPlan, page: ReplayPageFrame): void {
  if (page.firstRevision !== plan.nextRevision) {
    throw new RecoveryValidationError("replay page revision range is not exact-next");
  }
  if (page.lastRevision !== page.firstRevision + page.events.length - 1) {
    throw new RecoveryValidationError("replay page revision range is not exact-next");
  }
  if (page.lastRevision > plan.head.revision) {
    throw new RecoveryValidationError("replay page advances beyond its declared head");
  }
}

function assertReplayEvents(page: ReplayPageFrame): void {
  for (const [index, event] of page.events.entries()) {
    const revision = page.firstRevision + index;
    if (event.baseRevision !== revision - 1) {
      throw new RecoveryValidationError("replay event is not contiguous with its page");
    }
    if (event.revision !== revision) {
      throw new RecoveryValidationError("replay event is not contiguous with its page");
    }
  }
}

function assertReplayPageByteSize(pageBytes: number): void {
  if (pageBytes > RECOVERY_LIMITS.maxReplayPageBytes) {
    throw new RecoveryValidationError("replay page exceeds the maximum encoded size");
  }
}

function assertCompleteReplaySize(replayEventCount: number, replayBytes: number): void {
  if (replayEventCount > RECOVERY_LIMITS.maxReplayEvents) {
    throw new RecoveryValidationError("complete replay exceeds its configured bounds");
  }
  if (replayBytes > RECOVERY_LIMITS.maxReplayBytes) {
    throw new RecoveryValidationError("complete replay exceeds its configured bounds");
  }
}

function encodedEventBytes(events: readonly ReplayPageFrame["events"][number][]): number {
  return events.reduce((total, event) => total + encodedBytes(event), 0);
}

function encodedBytes(value: unknown): number {
  return canonicalJsonBytes(value as CanonicalJson).byteLength;
}

function assertHead(head: SyncHead): void {
  if (!isNonNegativeInteger(head.revision)) {
    throw new RecoveryValidationError("invalid recovery head");
  }
  if (!isPositiveInteger(head.stateSchemaVersion)) {
    throw new RecoveryValidationError("invalid recovery head");
  }
  if (!/^[0-9a-f]{64}$/u.test(head.stateDigest)) {
    throw new RecoveryValidationError("invalid recovery head");
  }
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function sameHead(left: Pick<SyncHead, "revision" | "stateSchemaVersion" | "stateDigest">, right: SyncHead): boolean {
  return left.revision === right.revision && left.stateSchemaVersion === right.stateSchemaVersion && left.stateDigest === right.stateDigest;
}
