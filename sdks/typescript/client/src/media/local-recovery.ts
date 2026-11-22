// A local publication the registry drops still has a live track sending it, so the
// client republishes it. Each source gets one scheduled recovery intent; the book keeps
// the intent, its backoff, and the health window that resets the backoff after a quiet
// spell. The attempts themselves belong to the coordinator and run through #run.
import type { MediaPublicationSource } from "./plane";
import { localSourceGroup, RECOVERY_HEALTHY_RESET_MS, recoveryBackoffMs } from "./sfu-limits";
import type { LocalTrackState } from "./local-publications";

export type LocalRecovery = {
  readonly state: LocalTrackState;
  readonly deadPublicationId: string | null;
  relist: boolean;
  retiring: boolean;
  attempt: number;
  timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  running: boolean;
};

/** What the scheduler needs from the coordinator. */
export interface LocalRecoverySchedulerOps {
  readonly stopped: () => boolean;
  readonly paused: (source: MediaPublicationSource) => boolean;
  readonly stateOf: (source: MediaPublicationSource) => LocalTrackState | undefined;
  readonly run: (source: MediaPublicationSource) => void;
}

export class LocalRecoveryScheduler {
  readonly #ops: LocalRecoverySchedulerOps;
  readonly #recoveries = new Map<MediaPublicationSource, LocalRecovery>();
  readonly #recents = new Map<MediaPublicationSource, { count: number; healthySince: number }>();

  constructor(ops: LocalRecoverySchedulerOps) {
    this.#ops = ops;
  }

  has(source: MediaPublicationSource): boolean {
    return this.#recoveries.has(source);
  }
  get(source: MediaPublicationSource): LocalRecovery | undefined {
    return this.#recoveries.get(source);
  }
  canBegin(state: LocalTrackState): boolean {
    return state.enabled && state.desiredEnabled && !this.#ops.stopped() && !this.#ops.paused(state.source) && !this.#recoveries.has(state.source);
  }
  begin(state: LocalTrackState, deadPublicationId: string | null, relist: boolean): void {
    if (!this.canBegin(state)) return;
    const now = Date.now();
    const delayMs = this.#startDelay(state.source, now);
    const recovery: LocalRecovery = { state, deadPublicationId, relist, retiring: false, attempt: 0, timer: undefined, running: false };
    this.#recoveries.set(state.source, recovery);
    this.#schedule(recovery, delayMs);
  }
  #startDelay(source: MediaPublicationSource, now: number): number {
    const recent = this.#recents.get(source);
    if (!recent || now - recent.healthySince >= RECOVERY_HEALTHY_RESET_MS) {
      this.#recents.set(source, { count: 0, healthySince: now });
      return 0;
    }
    this.#recents.set(source, { count: recent.count + 1, healthySince: now });
    return recoveryBackoffMs(recent.count);
  }
  #schedule(recovery: LocalRecovery, delayMs: number): void {
    recovery.timer = globalThis.setTimeout(() => {
      recovery.timer = undefined;
      if (this.#recoveries.get(recovery.state.source) !== recovery) return;
      this.#ops.run(recovery.state.source);
    }, delayMs);
  }
  canRecover(recovery: LocalRecovery): boolean {
    return this.#recoveries.get(recovery.state.source) === recovery && !this.#ops.stopped() && !this.#ops.paused(recovery.state.source) && this.#ops.stateOf(recovery.state.source) === recovery.state;
  }
  /** Drops an intent that can no longer be served; true when it was dropped. */
  discard(recovery: LocalRecovery): boolean {
    if (this.canRecover(recovery)) return false;
    this.drop(recovery.state.source, recovery);
    return true;
  }
  canContinue(recovery: LocalRecovery): boolean {
    if (!this.canRecover(recovery) || recovery.retiring) return this.canRecover(recovery);
    if (recovery.deadPublicationId !== null && recovery.state.providerPublicationId !== recovery.deadPublicationId) return false;
    return recovery.state.desiredEnabled;
  }
  /** A republish that named a new publication ends the intent; a parked one is already what pause wants. */
  settle(recovery: LocalRecovery, published: boolean): boolean {
    const source = recovery.state.source;
    if (!published && this.#ops.paused(source)) {
      this.drop(source, recovery);
      return true;
    }
    const publicationId = recovery.state.providerPublicationId;
    if (!published || publicationId === null || publicationId === recovery.deadPublicationId) return false;
    const recent = this.#recents.get(source);
    if (recent) this.#recents.set(source, { ...recent, healthySince: Date.now() });
    this.drop(source, recovery);
    return true;
  }
  retry(recovery: LocalRecovery): void {
    if (!this.canRecover(recovery)) {
      this.drop(recovery.state.source, recovery);
      return;
    }
    this.#schedule(recovery, recoveryBackoffMs(recovery.attempt++));
  }
  drop(source: MediaPublicationSource, expected?: LocalRecovery): void {
    for (const item of localSourceGroup(source)) {
      const recovery = this.#recoveries.get(item);
      if (!recovery || (expected && recovery !== expected)) continue;
      if (recovery.timer !== undefined) globalThis.clearTimeout(recovery.timer);
      this.#recoveries.delete(item);
    }
  }
  clear(): void {
    for (const source of [...this.#recoveries.keys()]) this.drop(source);
    this.#recents.clear();
  }
}
