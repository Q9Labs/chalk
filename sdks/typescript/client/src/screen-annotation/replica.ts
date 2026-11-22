import { applyChange } from "./change";
import { screenAnnotationV1, type components } from "../generated/screen-annotation-v1";
import { encodeAnnotationFrame } from "./codec";
import type { ScreenAnnotationClient, ScreenAnnotationResult, ScreenAnnotationSnapshot, ScreenAnnotationTarget } from "./index";

type Wire = components["schemas"];
type Target = ScreenAnnotationTarget;
type Result = ScreenAnnotationResult;
type Pending = {
  readonly wire: string;
  readonly publicationId?: string;
  readonly resolve: (result: Result) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};
type Sample = Wire["ClientPresence"];

const limits = screenAnnotationV1.limits;
const maxPending = 32;
const sampleIntervalMs = Math.ceil(1_000 / limits.previewPerSecond);
const unknown = { kind: "delivery_unknown" } as const;
const unavailable = { kind: "unavailable" } as const;

export class AnnotationReplica implements ScreenAnnotationClient {
  readonly #send: (wire: string) => boolean;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<string, Pending>();
  readonly #presence = new Map<string, Wire["ServerPresence"]>();
  #snapshot: ScreenAnnotationSnapshot = { status: "connecting" };
  #live = false;
  #retryAfterReconnect = false;
  #sample: Sample | null = null;
  #sampleTimer: ReturnType<typeof setTimeout> | undefined;
  #lastSampleSentAt = -Infinity;
  #stateExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #stateRequestedAt: number | undefined;
  #clockOffset = Date.now() - performance.now();

  constructor(send: (wire: string) => boolean) {
    this.#send = send;
  }

  getSnapshot = (): ScreenAnnotationSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  serverNowMs = (): number => performance.now() + this.#clockOffset;

  enterLive(negotiated: boolean): void {
    this.#live = negotiated;
    this.#retryAfterReconnect = negotiated;
    if (negotiated) this.#requestState();
    else this.#reset("unavailable", true);
  }

  disconnected(terminal = false): void {
    this.#live = false;
    this.#stateRequestedAt = undefined;
    this.#reset(terminal ? "unavailable" : "connecting", terminal);
  }

  receive(frame: Wire["ServerFrame"]): void {
    if (!this.#live) return;
    switch (frame.type) {
      case "annotation_state": {
        const recovering = this.#snapshot.status === "connecting";
        this.#anchorClock(frame.server_at_ms, recovering);
        this.#clearPresence();
        this.#set({ status: "ready", state: frame.state, presence: [] });
        if (this.#retryAfterReconnect) {
          this.#retryAfterReconnect = false;
          // Only an outstanding delivery is retried. The exact original bytes
          // (including address, fence and ID) are immutable across reconnects.
          for (const pending of this.#pending.values()) this.#send(pending.wire);
        }
        return;
      }
      case "annotation_closed":
        if (this.#state()?.layer.layer_id !== frame.layer_id) return;
        this.#clearPresence();
        this.#set({ status: "ready", state: null, presence: [] });
        return;
      case "annotation_receipt":
        this.#settle(frame.operation_id, frame.result);
        return;
      case "annotation_presence":
        this.#receivePresence(frame);
        return;
      case "annotation_changed":
        this.#receiveChange(frame);
    }
  }

  bind(publicationId: string, frame: Wire["FrameSize"]): Promise<Result> {
    if (this.#state()?.layer.publication_id === publicationId || Array.from(this.#pending.values()).some((pending) => pending.publicationId === publicationId)) {
      return Promise.resolve(unavailable);
    }
    return this.#command(null, { kind: "bind", publication_id: publicationId, frame });
  }

  dispatch(target: Target, command: Wire["Command"]): Promise<Result> {
    if (!this.#live || this.#snapshot.status !== "ready") return Promise.resolve(unavailable);
    const state = this.#snapshot.state;
    if (state?.layer.layer_id !== target.layerId) return Promise.resolve({ kind: "rejected", reason: "stale_layer" });
    if (state.fence !== target.fence) return Promise.resolve({ kind: "rejected", reason: "stale_fence" });
    return this.#command(target, command);
  }

  setPresence(target: Target, cursor: Wire["Cursor"] | null, draft: Wire["Draft"] | null): void {
    const state = this.#state();
    if (!this.#live || state?.layer.layer_id !== target.layerId || state.fence !== target.fence || !state.access.can_draw) return;

    this.#sample = { type: "annotation_presence", layer_id: target.layerId, fence: target.fence, cursor, draft };
    if (this.#sampleTimer !== undefined) return;
    const delay = this.#lastSampleSentAt + sampleIntervalMs - performance.now();
    if (delay <= 0) this.#flushSample();
    else this.#sampleTimer = setTimeout(() => this.#flushSample(), Math.ceil(delay));
  }

  #flushSample(): void {
    const sample = this.#sample;
    this.#sample = null;
    this.#sampleTimer = undefined;
    const wire = sample && encodeAnnotationFrame(sample);
    if (wire && this.#send(wire)) this.#lastSampleSentAt = performance.now();
  }

  #command(target: Target | null, command: Wire["Command"] | Wire["Bind"]): Promise<Result> {
    if (!this.#live || this.#snapshot.status !== "ready") return Promise.resolve(unavailable);
    if (this.#pending.size >= maxPending) return Promise.resolve({ kind: "rejected", reason: "rate_limited" });
    const operationId = uuidV7(Date.now());
    const fields = { type: "annotation_command", operation_id: operationId } as const;
    const frame: Wire["ClientCommand"] | null = command.kind === "bind" ? { ...fields, layer_id: null, fence: null, command } : target && { ...fields, layer_id: target.layerId, fence: target.fence, command };
    const wire = frame && encodeAnnotationFrame(frame);
    if (!wire) return Promise.resolve({ kind: "rejected", reason: "invalid_target" });

    return new Promise((resolve) => {
      this.#pending.set(operationId, {
        wire,
        publicationId: command.kind === "bind" ? command.publication_id : undefined,
        resolve,
        timeout: setTimeout(() => this.#settle(operationId, unknown), 10_000),
      });
      if (!this.#send(wire)) this.#settle(operationId, unknown);
    });
  }

  #settle(id: string, result: Result): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(id);
    pending.resolve(result);
  }

  #receiveChange(frame: Wire["ServerChange"]): void {
    const state = this.#state();
    if (!state) return;
    if (state.layer.layer_id !== frame.layer_id || frame.revision <= state.revision) return;
    if (frame.revision !== state.revision + 1 || frame.fence < state.fence || frame.fence > state.fence + 1) {
      this.#requestState();
      return;
    }

    this.#anchorClock(frame.server_at_ms, false);
    if (frame.fence !== state.fence) this.#clearPresence();
    const next = applyChange(state, frame);
    if (frame.change.kind === "upsert") {
      const mark = frame.change.mark;
      if (this.#presence.get(mark.author.participant_id)?.draft?.mark_id === mark.draft.mark_id) {
        this.#presence.delete(mark.author.participant_id);
      }
    }
    this.#set({ status: "ready", state: next, presence: Array.from(this.#presence.values()) });
  }

  #receivePresence(frame: Wire["ServerPresence"]): void {
    const state = this.#state();
    if (!state || frame.layer_id !== state.layer.layer_id || frame.fence !== state.fence) return;
    const authorId = frame.author.participant_id;
    const previous = this.#presence.get(authorId);
    if (previous && previous.server_at_ms > frame.server_at_ms) return;

    const draftId = frame.draft?.mark_id;
    if (draftId && state.marks.some((mark) => mark.draft.mark_id === draftId)) return;
    if ((!frame.draft && !frame.cursor) || frame.expires_at_ms <= this.serverNowMs()) this.#presence.delete(authorId);
    else this.#presence.set(authorId, frame);
    this.#publishPresence();
  }

  #publishPresence(): void {
    if (this.#snapshot.status !== "ready") return;
    clearTimeout(this.#expiryTimer);
    const now = this.serverNowMs();
    let nextExpiry = Infinity;
    for (const [id, sample] of this.#presence) {
      if (sample.expires_at_ms <= now) this.#presence.delete(id);
      else nextExpiry = Math.min(nextExpiry, sample.expires_at_ms);
    }
    if (Number.isFinite(nextExpiry)) this.#expiryTimer = setTimeout(() => this.#publishPresence(), Math.ceil(nextExpiry - now));
    this.#set({ ...this.#snapshot, presence: Array.from(this.#presence.values()) });
  }

  #state(): Wire["State"] | null {
    return this.#snapshot.status === "ready" ? this.#snapshot.state : null;
  }

  #anchorClock(serverAt: number, reanchor: boolean): void {
    const receivedAt = performance.now();
    const requestedAt = this.#stateRequestedAt;
    if (reanchor) {
      // Estimate the server clock at the midpoint of a recent state round trip.
      // A delayed or unsolicited snapshot can only establish a lower bound.
      const recent = requestedAt !== undefined && receivedAt - requestedAt <= 2_000;
      const localAtSample = recent ? (requestedAt + receivedAt) / 2 : receivedAt;
      this.#clockOffset = serverAt - localAtSample;
      this.#stateRequestedAt = undefined;
    } else {
      this.#clockOffset = Math.max(serverAt - receivedAt, this.#clockOffset);
    }
  }

  #requestState(): void {
    this.#reset("connecting", false);
    this.#stateRequestedAt = performance.now();
    if (!this.#send(JSON.stringify({ type: "annotation_state_request" }))) {
      this.#stateRequestedAt = undefined;
    }
  }

  #clearPresence(): void {
    this.#presence.clear();
    this.#sample = null;
    clearTimeout(this.#sampleTimer);
    clearTimeout(this.#expiryTimer);
    this.#sampleTimer = undefined;
    this.#expiryTimer = undefined;
  }

  #reset(status: "connecting" | "unavailable", discard: boolean): void {
    this.#clearPresence();
    if (discard) {
      for (const id of this.#pending.keys()) this.#settle(id, unknown);
    }
    if (this.#snapshot.status !== status) this.#set({ status });
  }

  #set(snapshot: ScreenAnnotationSnapshot): void {
    if (snapshot.status !== "ready" || snapshot.state !== this.#state()) {
      clearTimeout(this.#stateExpiryTimer);
      if (snapshot.status === "ready" && snapshot.state) {
        snapshot = { ...snapshot, state: this.#expireState(snapshot.state) };
      }
    }
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #expireState(state: Wire["State"]): Wire["State"] {
    const now = this.serverNowMs();
    let nextExpiry = Infinity;
    const fresh = (value: { readonly expires_at_ms: number | null }): boolean => {
      const expiry = value.expires_at_ms;
      if (expiry === null) return true;
      if (expiry <= now) return false;
      nextExpiry = Math.min(nextExpiry, expiry);
      return true;
    };
    const marks = state.marks.filter(fresh);
    const requests = state.access.requests.filter(fresh);
    if (Number.isFinite(nextExpiry)) {
      this.#stateExpiryTimer = setTimeout(
        () => {
          if (this.#snapshot.status === "ready" && this.#snapshot.state) {
            this.#set({ ...this.#snapshot, state: { ...this.#snapshot.state } });
          }
        },
        Math.ceil(nextExpiry - now),
      );
    }
    return { ...state, marks, access: { ...state.access, requests } };
  }
}

function uuidV7(timeMs: number): string {
  const nonce = crypto.randomUUID();
  const timestamp = timeMs.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${nonce.slice(15)}`;
}
