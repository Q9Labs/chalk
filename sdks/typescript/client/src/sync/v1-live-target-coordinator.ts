import type { SyncV1ClientFrame } from "../generated/sync";
import type { MediaPlaneResult, MediaPlaneTarget } from "../media/plane";
import { encodeV1ClientFrame } from "./v1-codec";
import { rejectV1Deferred, resolveV1Deferred, type V1Deferred } from "./v1-deferred";
import { V1SyncError } from "./v1-error";
import { frameSignature } from "./v1-frame-signature";
import { V1ReplicaError } from "./v1-reducer";
import { V1TimerMap } from "./v1-timer-map";
import type { V1LiveTargetResult, V1MediaPublication, V1MediaSource, V1SelfMediaTargetResult, V1SyncClientOptions } from "./v1-types";

const MAX_RETRIES = 3;
const MAX_LIVE_SERVER_RETRIES = 16;
const LIVE_TARGET_RETRY_BUDGET_MS = 15_000;
const LOCAL_MEDIA_TIMEOUT_MS = 45_000;
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
  // The plane's head start for this enable, until the head start is undone. It is `started` once the plane has been asked to begin it.
  headStart?: { readonly target: MediaPlaneTarget; started: boolean };
};

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
  readonly #retryTimers: V1TimerMap;
  readonly #deadlineTimers: V1TimerMap;
  readonly #localMedia: Record<V1MediaSource, "unknown" | "requesting" | "enabled" | "disabled" | "failed"> = { microphone: "unknown", camera: "unknown", screen: "unknown" };

  constructor(options: V1LiveTargetCoordinatorOptions) {
    this.#options = options;
    this.#retryTimers = new V1TimerMap(options.clock);
    this.#deadlineTimers = new V1TimerMap(options.clock);
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

  send(name: "set_microphone_enabled" | "set_camera_enabled" | "set_screen_share_enabled", source: V1MediaSource, enabled: boolean, options?: { readonly requestId?: string }): Promise<V1SelfMediaTargetResult> {
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
    this.#deadlineTimers.schedule(
      operationId,
      () => {
        if (this.#targets.get(operationId) === deferred) this.#fail(operationId, deferred, new V1SyncError("self-media target confirmation timed out", "retry_exhausted"));
      },
      LIVE_TARGET_RETRY_BUDGET_MS,
    );
    this.#localMedia[source] = "requesting";
    this.#options.sendIfLive(frame);
    if (enabled) this.#prepareLocal(deferred, participantId);
    this.#options.stateChanged();
    return promise;
  }

  // The frame is already on the wire. Only work that needs no grant starts here. The plane may resume a parked track, which the
  // node forwards under its source lease at once, so this target owns undoing that head start (#cancelHeadStart) on every
  // path that does not execute it. A new publication waits for the server result in #executeLocal.
  #prepareLocal(deferred: LiveDeferred, participantId: string): void {
    const prepare = this.#options.mediaPlane?.prepareLocalPublicationTarget;
    if (!prepare) return;
    const target = { operationId: deferred.frame.operation_id, participantId, source: deferred.source, enabled: true };
    const headStart = { target, started: false };
    deferred.headStart = headStart;
    // #executeLocal redoes whatever the head start left undone and reports its failure, so a failed head start needs no handling here.
    void Promise.resolve()
      .then(() => {
        if (deferred.headStart !== headStart) return;
        headStart.started = true;
        return prepare.call(this.#options.mediaPlane, target);
      })
      .catch(() => {});
  }

  // Undoes the head start at once, without waiting for it: the plane silences the sender locally, then parks the track on the SFU
  // after its resume request has settled, even when that request got no answer. A head start that has not begun never does.
  // A listener must not hear audio the authority refuses, and the lease forwards it until this runs.
  #cancelHeadStart(deferred: LiveDeferred): void {
    const headStart = deferred.headStart;
    deferred.headStart = undefined;
    const cancel = this.#options.mediaPlane?.cancelPreparedLocalPublicationTarget;
    if (!headStart?.started || !cancel) return;
    // A failed cancel leaves the publication to the caller's own failure cleanup, which closes it.
    try {
      void cancel.call(this.#options.mediaPlane, headStart.target).catch(() => {});
    } catch {
      // A plane that throws instead of rejecting is handled the same way.
    }
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
    // The first answer that is not a success ends the head start: a retried frame is grant-gated again, and a final success
    // resumes through #executeLocal.
    if (!isSuccessfulLiveTargetResult(frame)) this.#cancelHeadStart(deferred);
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
    this.#retryTimers.cancel(frame.operation_id);
    this.#deadlineTimers.cancel(frame.operation_id);
    this.#deadlineTimers.schedule(
      frame.operation_id,
      () => {
        if (this.#targets.get(frame.operation_id) === deferred) this.#fail(frame.operation_id, deferred, new V1SyncError("Media did not respond in time. Try again.", "media_timeout"));
      },
      LOCAL_MEDIA_TIMEOUT_MS,
    );
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
    this.#retryTimers.cancelAll();
    this.#deadlineTimers.cancelAll();
    for (const deferred of this.#targets.values()) {
      this.#cancelHeadStart(deferred);
      rejectV1Deferred(deferred, new V1SyncError(code, code));
    }
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
    this.#retryTimers.schedule(operationId, () => this.#options.sendIfLive(deferred.frame), delay);
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
    this.#retryTimers.schedule(operationId, () => this.#executeLocal(operationId, deferred), this.#options.retryDelayMs ?? 100);
  }

  #settleLocal(operationId: string, deferred: LiveDeferred, result: MediaPlaneResult): void {
    if (!isSuccessfulMediaPlaneResult(result)) {
      if (result.errorCode === "signaling_timeout" || result.errorCode === "negotiation_timeout") {
        this.#fail(operationId, deferred, new V1SyncError("Media did not respond in time. Try again.", result.errorCode));
        return;
      }
      this.#fail(operationId, deferred, new V1SyncError(result.errorCode ?? result.outcome, result.outcome));
      return;
    }
    const serverResult = deferred.serverResult;
    if (!serverResult) throw new V1ReplicaError("local MediaPlane completed before server authorization");
    this.#targets.delete(operationId);
    this.#retryTimers.cancel(operationId);
    this.#deadlineTimers.cancel(operationId);
    this.#localMedia[deferred.source] = deferred.enabled ? "enabled" : "disabled";
    resolveV1Deferred(deferred, { operationId, name: deferred.frame.name, serverOutcome: serverResult.outcome, mediaPlaneOutcome: result.outcome });
    this.#options.stateChanged();
  }

  #fail(operationId: string, deferred: LiveDeferred, error: V1SyncError): void {
    this.#cancelHeadStart(deferred);
    this.#targets.delete(operationId);
    this.#retryTimers.cancel(operationId);
    this.#deadlineTimers.cancel(operationId);
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
