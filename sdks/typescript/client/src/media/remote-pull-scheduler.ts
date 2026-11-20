// The remote pull's scheduling policy: which publications are owed a pull, how long a
// failed one waits before it can be asked again, and whether the roster still has
// unreconciled work that keeps the poll coming back. The state used to be scattered
// between the client and the failure policy; it lives here now.
import { classifyMediaFailure } from "./failure-diagnostics";
import { LONG_PULL_DEFERRAL_MS, REMOTE_PULL_BACKOFF_LIMIT, remotePullBackoffMs, TRANSIENT_PULL_RETRY_MS } from "./cloudflare-limits";
import { CloudflareSFUError } from "./types";
import type { CloudflareSFUPublication, CloudflareSFURemoteTrack } from "./types";
import type { ReceiveStallRecovery } from "./receive-stall";

// A 5xx, a signaling timeout or a network failure usually clears in seconds, so the pull is retried
// after a short backoff. Rate limits (429), a gone connection (404, 410) and track failures stay on
// the long deferral, because an immediate retry cannot change their outcome.
export function transientRemotePull(error: unknown): boolean {
  const { media_error_kind: kind, http_status: status } = classifyMediaFailure(error, "sfu_tracks");
  return kind === "network" || kind === "timeout" || (typeof status === "number" && status >= 500);
}
export function retryableRemotePull(error: unknown): boolean {
  if (transientRemotePull(error)) return true;
  if (!(error instanceof CloudflareSFUError)) return false;
  if (error.code === "signaling_failed") return error.options.retryableConnection === true || error.options.status === 429;
  return ["signaling_timeout", "media_failed", "negotiation_timeout"].includes(error.code);
}
type RemotePullRetry = { readonly retryAfter: number; readonly failures: number; readonly receiveStalled?: boolean };

export class RemotePullScheduler {
  readonly #retries = new Map<string, RemotePullRetry>();
  readonly #subscribed = new Set<string>();
  #remoteParticipantIds: ReadonlySet<string> | null = null;
  // Bumped when the remote participants or tile visibility change, so a reconcile that raced the change pulls again.
  #inputRevision = 0;
  #incomplete = false;
  // The generation whose remote recovery spent the offer budget; a completed pull clears it.
  recoveryGeneration: number | null = null;
  // The join pulls the room's audio with its first poll, once per media client; later polls list as before.
  pullPublishedTried = false;

  get incomplete(): boolean {
    return this.#incomplete;
  }
  get inputRevision(): number {
    return this.#inputRevision;
  }
  /** New Sync advertisements or tile changes invalidate an in-flight reconcile and mark pulls owed. */
  noteInputChanged(): void {
    this.#inputRevision += 1;
    this.#incomplete = true;
  }
  markIncomplete(): void {
    this.#incomplete = true;
  }
  /** Records a reconcile's outcome; a complete pull settles the recovery generation. */
  settleCommit(incomplete: boolean): void {
    this.#incomplete = incomplete;
    if (!incomplete) this.recoveryGeneration = null;
  }
  observeCursor(incomplete: boolean): void {
    this.#incomplete = incomplete;
  }
  setRemoteParticipants(participantIds: readonly string[]): void {
    this.#remoteParticipantIds = new Set(participantIds);
  }
  canSubscribe(publication: CloudflareSFUPublication): boolean {
    return this.#remoteParticipantIds === null || this.#remoteParticipantIds.has(publication.participantId) || this.#subscribed.has(publication.publicationId);
  }
  noteSubscribed(publicationId: string): void {
    this.#subscribed.add(publicationId);
  }
  forget(publicationId: string): void {
    this.#retries.delete(publicationId);
  }
  /** A stalled pull keeps its backoff through an unrelated success so the stall verdict owns the retry. */
  forgetUnstalled(publicationId: string): void {
    if (!this.#retries.get(publicationId)?.receiveStalled) this.#retries.delete(publicationId);
  }
  isReceiveStalled(publicationId: string): boolean {
    return this.#retries.get(publicationId)?.receiveStalled === true;
  }
  // A hidden tile keeps its pull backoff and subscription eligibility; only a withdrawn publication loses them.
  prune(advertisedIds: ReadonlySet<string>): void {
    for (const publicationId of this.#retries.keys()) {
      if (!advertisedIds.has(publicationId)) this.#retries.delete(publicationId);
    }
    for (const publicationId of this.#subscribed) {
      if (!advertisedIds.has(publicationId)) this.#subscribed.delete(publicationId);
    }
  }
  clearRetries(): void {
    this.#retries.clear();
  }
  clear(): void {
    this.#retries.clear();
    this.#subscribed.clear();
  }
  /** A track error or a stalled pull that needs a new publication doubles the wait, capped. */
  backoff(publicationId: string, receiveStalled = false): void {
    const previous = this.#retries.get(publicationId) ?? { retryAfter: 0, failures: 0 };
    const failures = Math.min(previous.failures + 1, REMOTE_PULL_BACKOFF_LIMIT);
    this.#retries.set(publicationId, { retryAfter: Date.now() + remotePullBackoffMs(failures), failures, receiveStalled: receiveStalled || previous.receiveStalled });
  }
  defer(publications: readonly CloudflareSFUPublication[], error: unknown): void {
    const transient = transientRemotePull(error);
    const retryable = retryableRemotePull(error);
    for (const publication of publications) {
      const previous = this.#retries.get(publication.publicationId);
      const failures = previous?.failures ?? 0;
      const delay = transient ? (TRANSIENT_PULL_RETRY_MS[failures] ?? LONG_PULL_DEFERRAL_MS) : retryable ? LONG_PULL_DEFERRAL_MS : Number.POSITIVE_INFINITY;
      this.#retries.set(publication.publicationId, { retryAfter: Date.now() + delay, failures: transient ? Math.min(failures + 1, REMOTE_PULL_BACKOFF_LIMIT) : failures, receiveStalled: previous?.receiveStalled });
    }
  }
  pending(desired: ReadonlyMap<string, CloudflareSFUPublication>, remoteTracks: ReadonlyMap<string, CloudflareSFURemoteTrack>, receiveProgress: ReceiveStallRecovery, canReplace: boolean): CloudflareSFUPublication[] {
    const now = Date.now();
    return [...desired]
      .filter(([key, publication]) => {
        const id = publication.publicationId;
        const pulledAlready = remoteTracks.get(key)?.publicationId === id;
        if (pulledAlready && !receiveProgress.canRepull(id) && !(canReplace && receiveProgress.canRebuild(id))) return false;
        return (this.#retries.get(id)?.retryAfter ?? 0) <= now;
      })
      .map(([, publication]) => publication);
  }
}
