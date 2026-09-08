import type { SyncV1ClientFrame } from "../generated/sync";
import type { MediaPlaneResult } from "../media/plane";
import { encodeV1ClientFrame } from "./v1-codec";
import { rejectV1Deferred, resolveV1Deferred, type V1Deferred } from "./v1-deferred";
import { V1SyncError } from "./v1-error";
import { frameSignature } from "./v1-frame-signature";
import { V1ReplicaError } from "./v1-reducer";
import type { V1LiveTargetResult, V1MediaPublication, V1MediaSource, V1SelfMediaTargetResult, V1SyncClientOptions } from "./v1-types";

const MAX_RETRIES = 3;
const MAX_LIVE_SERVER_RETRIES = 16;
const LIVE_TARGET_RETRY_BUDGET_MS = 15_000;
const MAX_LIVE_TARGET_RETRY_DELAY_MS = 1_000;

type LiveTargetClientFrame = Extract<SyncV1ClientFrame, { readonly type: "live_target" }>;
type SuccessfulLiveTargetResult = Omit<V1LiveTargetResult, "outcome"> & { readonly outcome: "confirmed" | "satisfied" };
type SuccessfulMediaPlaneResult = Omit<MediaPlaneResult, "outcome"> & { readonly outcome: "confirmed" | "satisfied" };
type LiveDeferred = V1Deferred<V1SelfMediaTargetResult> & {
  readonly frame: LiveTargetClientFrame;
  readonly createdAt: number;
  serverRetries: number;
  localRetries: number;
  localInFlight: boolean;
  readonly source: V1MediaSource;
  readonly enabled: boolean;
  serverResult?: SuccessfulLiveTargetResult;
  serverResultSignature?: string;
};

type V1LiveTargetOptions = { readonly requestId?: string };

type V1LiveTargetCoordinatorOptions = {
  readonly mediaPlane: V1SyncClientOptions["mediaPlane"];
  readonly requestIds: V1SyncClientOptions["requestIds"];
  readonly retryDelayMs: number | undefined;
  readonly clock: () => NonNullable<V1SyncClientOptions["clock"]>;
  readonly participantId: () => string | null;
  readonly isLive: () => boolean;
  readonly requestIdInUse: (requestId: string) => boolean;
  readonly assertCapacity: () => void;
  readonly sendIfLive: (frame: SyncV1ClientFrame) => void;
  readonly stateChanged: () => void;
};

export class V1LiveTargetCoordinator {
  readonly #options: V1LiveTargetCoordinatorOptions;
  readonly #targets = new Map<string, LiveDeferred>();
  readonly #retryTimers = new Map<string, unknown>();
  readonly #deadlineTimers = new Map<string, unknown>();
  readonly #localMedia: Record<V1MediaSource, "unknown" | "requesting" | "enabled" | "disabled" | "failed"> = { microphone: "unknown", camera: "unknown", screen: "unknown" };

  constructor(options: V1LiveTargetCoordinatorOptions) {
    this.#options = options;
  }

  get pendingCount(): number {
    return this.#targets.size;
  }

  has(requestId: string): boolean {
    return this.#targets.has(requestId);
  }

  getLocalMedia(): Readonly<Record<V1MediaSource, "unknown" | "requesting" | "enabled" | "disabled" | "failed">> {
    return { ...this.#localMedia };
  }

  updateFromPublications(publications: readonly V1MediaPublication[]): void {
    const participantId = this.#options.participantId();
    if (!participantId) return;
    for (const source of ["microphone", "camera", "screen"] as const) {
      const publication = publications.find((candidate) => candidate.source === source && candidate.participantId === participantId);
      this.#localMedia[source] = publication?.enabled ? "enabled" : "disabled";
    }
  }

  resetLocalMedia(): void {
    for (const source of ["microphone", "camera", "screen"] as const) this.#localMedia[source] = "unknown";
  }

  send(name: "set_microphone_enabled" | "set_camera_enabled" | "set_screen_share_enabled", source: V1MediaSource, enabled: boolean, options?: V1LiveTargetOptions): Promise<V1SelfMediaTargetResult> {
    this.#options.assertCapacity();
    const participantId = this.#options.participantId();
    if (!this.#options.isLive() || !participantId) return Promise.reject(new V1SyncError("self-media targets require a live participant", "not_live"));
    if (!this.#options.mediaPlane) return Promise.reject(new V1SyncError("a client MediaPlane adapter is required for self-media targets", "media_plane_unavailable"));
    const operationId = options?.requestId ?? this.#nextRequestId();
    if (this.#targets.has(operationId) || this.#options.requestIdInUse(operationId)) throw new V1SyncError("request ID is already pending", "request_id_conflict");
    const frame: LiveTargetClientFrame = { type: "live_target", operation_id: operationId, name, enabled };
    encodeV1ClientFrame(frame);
    const { deferred, promise } = createLiveDeferred(frame, source, enabled, this.#now());
    this.#targets.set(operationId, deferred);
    const deadlineTimer = this.#options.clock().setTimeout(() => {
      this.#deadlineTimers.delete(operationId);
      if (this.#targets.get(operationId) === deferred) this.#fail(operationId, deferred, new V1SyncError("self-media target confirmation timed out", "retry_exhausted"));
    }, LIVE_TARGET_RETRY_BUDGET_MS);
    this.#deadlineTimers.set(operationId, deadlineTimer);
    this.#localMedia[source] = "requesting";
    this.#options.sendIfLive(frame);
    this.#options.stateChanged();
    return promise;
  }

  receive(frame: V1LiveTargetResult): void {
    this.#requireLive();
    const deferred = this.#matchingTarget(frame);
    if (!deferred || this.#acceptDuplicateServerResult(deferred, frame)) return;
    this.#applyServerResult(deferred, frame);
  }

  #matchingTarget(frame: V1LiveTargetResult): LiveDeferred | undefined {
    const deferred = this.#targets.get(frame.operation_id);
    return deferred?.frame.name === frame.name ? deferred : undefined;
  }

  #acceptDuplicateServerResult(deferred: LiveDeferred, frame: V1LiveTargetResult): boolean {
    if (!deferred.serverResultSignature) return false;
    if (deferred.serverResultSignature !== frameSignature(frame)) throw new V1ReplicaError("conflicting duplicate live-target result");
    return true;
  }

  #applyServerResult(deferred: LiveDeferred, frame: V1LiveTargetResult): void {
    if (frame.outcome === "retryable_failure") {
      this.#retryServer(frame.operation_id, deferred, frame.error_code ?? frame.outcome);
      return;
    }
    if (!isSuccessfulLiveTargetResult(frame)) {
      this.#fail(frame.operation_id, deferred, new V1SyncError(frame.error_code ?? frame.outcome, frame.outcome));
      return;
    }
    deferred.serverResult = frame;
    deferred.serverResultSignature = frameSignature(frame);
    this.#clearRetryTimer(frame.operation_id);
    this.#clearDeadlineTimer(frame.operation_id);
    this.#executeLocal(frame.operation_id, deferred);
  }

  enterLive(): void {
    for (const pending of this.#targets.values()) {
      pending.serverRetries = 0;
      if (pending.serverResult) this.#executeLocal(pending.frame.operation_id, pending);
      else this.#options.sendIfLive(pending.frame);
    }
  }

  disconnect(code: string): void {
    this.#clearTimers();
    for (const deferred of this.#targets.values()) rejectV1Deferred(deferred, new V1SyncError(code, code));
    this.#targets.clear();
  }

  #retryServer(operationId: string, deferred: LiveDeferred, errorCode: string): void {
    if (this.#retryTimers.has(operationId)) return;
    const remainingBudget = LIVE_TARGET_RETRY_BUDGET_MS - (this.#now() - deferred.createdAt);
    if (deferred.serverRetries >= MAX_LIVE_SERVER_RETRIES || remainingBudget <= 0) {
      this.#fail(operationId, deferred, new V1SyncError(errorCode, "retry_exhausted"));
      return;
    }
    deferred.serverRetries += 1;
    const baseDelay = this.#options.retryDelayMs ?? 100;
    const delay = Math.min(remainingBudget, MAX_LIVE_TARGET_RETRY_DELAY_MS, baseDelay * 2 ** Math.min(deferred.serverRetries - 1, 4));
    this.#scheduleRetry(operationId, () => this.#options.sendIfLive(deferred.frame), delay);
  }

  #executeLocal(operationId: string, deferred: LiveDeferred): void {
    const mediaPlane = this.#options.mediaPlane;
    const participantId = this.#options.participantId();
    if (!mediaPlane || !participantId || deferred.localInFlight || this.#targets.get(operationId) !== deferred) return;
    deferred.localInFlight = true;
    let result: Promise<MediaPlaneResult>;
    try {
      result = mediaPlane.setLocalPublicationTarget({ operationId, participantId, source: deferred.source, enabled: deferred.enabled });
    } catch {
      this.#localResult(operationId, deferred, { outcome: "ambiguous", errorCode: "media_plane_exception" });
      return;
    }
    void result.then((outcome) => this.#localResult(operationId, deferred, normalizeMediaPlaneResult(outcome))).catch(() => this.#localResult(operationId, deferred, { outcome: "ambiguous", errorCode: "media_plane_exception" }));
  }

  #localResult(operationId: string, deferred: LiveDeferred, result: MediaPlaneResult): void {
    if (this.#targets.get(operationId) !== deferred) return;
    deferred.localInFlight = false;
    if (result.outcome === "retryable_failure") {
      this.#retryLocal(operationId, deferred, result);
      return;
    }
    this.#settleLocal(operationId, deferred, result);
  }

  #retryLocal(operationId: string, deferred: LiveDeferred, result: MediaPlaneResult): void {
    if (deferred.localRetries >= MAX_RETRIES) {
      this.#fail(operationId, deferred, new V1SyncError(result.errorCode ?? result.outcome, "retry_exhausted"));
      return;
    }
    deferred.localRetries += 1;
    this.#scheduleRetry(operationId, () => this.#executeLocal(operationId, deferred));
  }

  #settleLocal(operationId: string, deferred: LiveDeferred, result: MediaPlaneResult): void {
    if (!isSuccessfulMediaPlaneResult(result)) {
      this.#fail(operationId, deferred, new V1SyncError(result.errorCode ?? result.outcome, result.outcome));
      return;
    }
    const serverResult = deferred.serverResult;
    if (!serverResult) throw new V1ReplicaError("local MediaPlane completed before server authorization");
    this.#targets.delete(operationId);
    this.#clearRetryTimer(operationId);
    this.#clearDeadlineTimer(operationId);
    this.#localMedia[deferred.source] = deferred.enabled ? "enabled" : "disabled";
    resolveV1Deferred(deferred, { operationId, name: deferred.frame.name, serverOutcome: serverResult.outcome, mediaPlaneOutcome: result.outcome });
    this.#options.stateChanged();
  }

  #scheduleRetry(operationId: string, retry: () => void, delay = this.#options.retryDelayMs ?? 100): void {
    const timer = this.#options.clock().setTimeout(() => {
      this.#retryTimers.delete(operationId);
      retry();
    }, delay);
    this.#retryTimers.set(operationId, timer);
  }

  #fail(operationId: string, deferred: LiveDeferred, error: V1SyncError): void {
    this.#targets.delete(operationId);
    this.#clearRetryTimer(operationId);
    this.#clearDeadlineTimer(operationId);
    this.#localMedia[deferred.source] = "failed";
    rejectV1Deferred(deferred, error);
    this.#options.stateChanged();
  }

  #nextRequestId(): string {
    return this.#options.requestIds?.next() ?? crypto.randomUUID();
  }

  #now(): number {
    return this.#options.clock().now();
  }

  #requireLive(): void {
    if (!this.#options.isLive()) throw new V1ReplicaError("live frame arrived before four-stream recovery completed");
  }

  #clearTimers(): void {
    for (const timer of this.#retryTimers.values()) this.#options.clock().clearTimeout(timer);
    for (const timer of this.#deadlineTimers.values()) this.#options.clock().clearTimeout(timer);
    this.#retryTimers.clear();
    this.#deadlineTimers.clear();
  }

  #clearRetryTimer(operationId: string): void {
    const timer = this.#retryTimers.get(operationId);
    if (timer === undefined) return;
    this.#options.clock().clearTimeout(timer);
    this.#retryTimers.delete(operationId);
  }

  #clearDeadlineTimer(operationId: string): void {
    const timer = this.#deadlineTimers.get(operationId);
    if (timer === undefined) return;
    this.#options.clock().clearTimeout(timer);
    this.#deadlineTimers.delete(operationId);
  }
}

function validMediaPlaneResult(result: MediaPlaneResult): boolean {
  return (result.outcome === "confirmed" || result.outcome === "satisfied" || result.outcome === "retryable_failure" || result.outcome === "terminal_failure" || result.outcome === "ambiguous") && (result.errorCode === null || typeof result.errorCode === "string");
}

function normalizeMediaPlaneResult(result: MediaPlaneResult): MediaPlaneResult {
  return validMediaPlaneResult(result) ? result : { outcome: "ambiguous", errorCode: "invalid_media_plane_result" };
}

function isSuccessfulLiveTargetResult(result: V1LiveTargetResult): result is SuccessfulLiveTargetResult {
  return result.outcome === "confirmed" || result.outcome === "satisfied";
}

function isSuccessfulMediaPlaneResult(result: MediaPlaneResult): result is SuccessfulMediaPlaneResult {
  return result.outcome === "confirmed" || result.outcome === "satisfied";
}

function createLiveDeferred(frame: LiveTargetClientFrame, source: V1MediaSource, enabled: boolean, createdAt: number): { readonly deferred: LiveDeferred; readonly promise: Promise<V1SelfMediaTargetResult> } {
  let resolvePromise = (_value: V1SelfMediaTargetResult): void => undefined;
  let rejectPromise = (_error: Error): void => undefined;
  const promise = new Promise<V1SelfMediaTargetResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    deferred: {
      resolve: resolvePromise,
      reject: rejectPromise,
      settled: false,
      frame,
      createdAt,
      serverRetries: 0,
      localRetries: 0,
      localInFlight: false,
      source,
      enabled,
    },
    promise,
  };
}
