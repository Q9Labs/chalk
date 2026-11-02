import type { MediaPublication } from "./plane";

export type AudioReadiness = "connecting" | "ready" | "degraded";

export const AUDIO_READY_CEILING_MS = 15_000;

/**
 * Decides when a listener can hear everyone whose microphone was on at join.
 *
 * The cohort is the set of remote participants with an enabled microphone in the first full
 * publication list after join. Later speakers never join it, so a late unmute cannot hold a ready
 * listener back. A cohort member whose microphone goes off, or who leaves, is dropped: nobody waits
 * for audio that will never come. A member who republishes before ready must be heard again on the new publication. `ready` needs inbound packets to increase for every remaining
 * member (consecutive receive samples, so a single stray packet is not enough), or, with an empty
 * cohort, a live media connection. It never moves back to `connecting`. `degraded` is set when the
 * ceiling passes first and still turns `ready` later if the audio arrives.
 */
export class AudioReadinessTracker {
  #state: AudioReadiness = "connecting";
  // Cohort member -> the publication whose packets were heard, or null while unheard.
  #cohort: Map<string, string | null> | null = null;
  #publicationOwners = new Map<string, string>();
  #connectionLive = false;

  get state(): AudioReadiness {
    return this.#state;
  }

  /** Records the live microphones. Returns true when the state changed. */
  expect(publications: readonly MediaPublication[], selfParticipantId: string): boolean {
    // An enabled microphone without a publication id is still a speaker to wait for: it cannot count as heard until an id arrives.
    const microphones = publications.filter((publication) => publication.source === "microphone" && publication.enabled && publication.participantId !== selfParticipantId);
    this.#publicationOwners = new Map(microphones.flatMap((publication) => (publication.publicationId === null ? [] : [[publication.publicationId, publication.participantId] as const])));
    const present = new Set(microphones.map((publication) => publication.participantId));
    if (this.#cohort === null) this.#cohort = new Map([...present].map((participantId) => [participantId, null]));
    else this.#reconcile(microphones);
    return this.#evaluate();
  }

  /** Publication ids whose inbound packet count increased between two receive samples. */
  advanced(publicationIds: readonly string[]): boolean {
    if (this.#cohort === null) return false;
    for (const publicationId of publicationIds) {
      const owner = this.#publicationOwners.get(publicationId);
      if (owner !== undefined && this.#cohort.has(owner)) this.#cohort.set(owner, publicationId);
    }
    return this.#evaluate();
  }

  connection(live: boolean): boolean {
    this.#connectionLive = live;
    return this.#evaluate();
  }

  /** The ceiling passed. Returns true when the state changed. */
  ceilingPassed(): boolean {
    if (this.#state !== "connecting") return false;
    this.#state = "degraded";
    return true;
  }

  /** Drops members who are gone and forgets proof from a publication that was replaced: the new one has not been heard. */
  #reconcile(microphones: readonly MediaPublication[]): void {
    if (this.#cohort === null) return;
    const current = new Map(microphones.map((publication) => [publication.participantId, publication.publicationId]));
    for (const [participantId, heard] of this.#cohort) {
      if (!current.has(participantId)) this.#cohort.delete(participantId);
      else if (heard !== null && heard !== current.get(participantId)) this.#cohort.set(participantId, null);
    }
  }

  #evaluate(): boolean {
    if (this.#state === "ready" || this.#cohort === null || !this.#connectionLive) return false;
    for (const heard of this.#cohort.values()) if (heard === null) return false;
    this.#state = "ready";
    return true;
  }
}
