// Swapping the whole SFU connection heals what an in-place fix cannot: a dropped
// session, a dead path that never negotiated, an offer that outgrew its budget. Each
// generation may spend one replacement (attemptedGeneration), so a failing recover
// cannot loop on fresh connections. The swap itself — fencing publications, disposing
// and rebuilding the peer connection — belongs to the coordinator through #ops.adopt.
import type { MediaConnectionReplacementCause } from "./plane";
import { validateBootstrap } from "./client-validation";
import { connectionIsLive } from "./peer-connection";
import { DEAD_SESSION_STATUSES } from "./sfu-limits";
import { SFUError } from "./types";
import type { SFUBootstrap } from "./types";

/** A signaling failure the node marks retryable is healed by a fresh connection. */
export function retryableConnectionFailure(error: unknown): boolean {
  return error instanceof SFUError && error.code === "signaling_failed" && error.options.retryableConnection === true;
}
/** An offer rejected on a connection that never came up is a dead session, not a bad offer. */
export function rejectedOnDeadConnection(error: unknown, connection: RTCPeerConnection): boolean {
  return error instanceof SFUError && error.code === "signaling_failed" && DEAD_SESSION_STATUSES.has(error.options.status) && !connectionIsLive(connection);
}

/** What the replacer needs from the coordinator. */
export interface MediaConnectionReplacerOps {
  readonly requestReplacement: () => ((observedConnectionId: string) => Promise<SFUBootstrap>) | undefined;
  readonly observedConnectionId: () => string;
  readonly generation: () => number;
  readonly stopped: () => boolean;
  readonly started: () => boolean;
  readonly negotiatedGeneration: () => number | null;
  readonly keepsIdleSession: () => boolean;
  readonly connection: () => RTCPeerConnection;
  readonly sdpPending: () => number;
  readonly requireGeneration: (generation: number) => void;
  readonly serializeSDP: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly adopt: (bootstrap: SFUBootstrap, cause: MediaConnectionReplacementCause) => void;
  readonly republish: (generation: number) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}

export class MediaConnectionReplacer {
  readonly #ops: MediaConnectionReplacerOps;
  attemptedGeneration: number | null = null;
  #replacement: { readonly generation: number; readonly promise: Promise<void> } | null = null;
  #cause: MediaConnectionReplacementCause | undefined;

  constructor(ops: MediaConnectionReplacerOps) {
    this.#ops = ops;
  }

  get pending(): { readonly generation: number; readonly promise: Promise<void> } | null {
    return this.#replacement;
  }
  /** The first signaling attempt on the new binding reports its origin; extra query parameters also work with older APIs. */
  noteCause(cause: MediaConnectionReplacementCause): void {
    this.#cause = cause;
  }
  takeCause(): MediaConnectionReplacementCause | undefined {
    const cause = this.#cause;
    this.#cause = undefined;
    return cause;
  }
  replace(generation: number, cause: MediaConnectionReplacementCause): Promise<void> {
    this.#ops.requireGeneration(generation);
    if (this.#replacement?.generation === generation) return this.#replacement.promise;
    const requestReplacement = this.#ops.requestReplacement();
    if (!requestReplacement || this.attemptedGeneration === generation) {
      return Promise.reject(new SFUError("A fresh Chalk SFU connection is unavailable", "signaling_failed"));
    }
    this.attemptedGeneration = generation;
    const promise = Promise.resolve().then(async () => {
      // A restart that ran while this was queued already adopted a binding; asking again would replace that one.
      this.#ops.requireGeneration(generation);
      const bootstrap = await requestReplacement(this.#ops.observedConnectionId());
      this.#ops.requireGeneration(generation);
      validateBootstrap(bootstrap);
      if (bootstrap.connectionId === this.#ops.observedConnectionId()) {
        throw new SFUError("Participant access did not replace the Chalk SFU connection", "signaling_failed");
      }
      this.#ops.adopt(bootstrap, cause);
    });
    const replacement = { generation, promise };
    this.#replacement = replacement;
    const settled = () => {
      if (this.#replacement === replacement) this.#replacement = null;
    };
    void promise.then(settled, settled);
    return promise;
  }
  async replaceDormantBeforeNegotiation(generation: number): Promise<void> {
    if (!this.#ops.started() || this.#ops.negotiatedGeneration() === generation || this.attemptedGeneration === generation || !this.#ops.requestReplacement()) return;
    // The Chalk SFU keeps an unused connection until it reports it gone, and the publish recovers from that report.
    if (this.#ops.keepsIdleSession()) return;
    await this.replace(generation, "dormant_connection");
  }
  // The SFU answers 404 or 410 once it has dropped this session, and ICE cannot bring a dropped session back. Replace now,
  // instead of waiting for the browser to give up on the path and for the ICE restart on the dead session to fail.
  // An SDP operation in flight talks to the same dropped session and replaces the connection itself when it fails, and a read
  // that finds the session still gone repeats within seconds. Replacing under it would clear the state that operation reads.
  replaceGone(): void {
    if (this.#ops.sdpPending() > 0) return;
    const generation = this.#ops.generation();
    const connection = this.#ops.connection();
    void this.#ops
      .serializeSDP(async () => {
        if (generation !== this.#ops.generation() || this.#ops.stopped() || connection !== this.#ops.connection() || this.attemptedGeneration === generation) return false;
        await this.replace(generation, "remote_signaling_failure");
        return true;
      })
      .then((replaced) => (replaced ? this.#ops.republish(generation) : undefined))
      .catch((error: unknown) => {
        if (generation === this.#ops.generation() && !this.#ops.stopped()) this.#ops.reportError(error);
      });
  }
}
