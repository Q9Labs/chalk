import type { SFUSubscriptionState } from "./types";

/** A video quiet this long asks the SFU whether it paused it, which leaves the read about five seconds of the stall window. */
export const SUBSCRIPTION_READ_AFTER_QUIET_MS = 2000;
/** A paused video is read this often until RTP returns or the SFU says it resumed, and a failed read waits this long. */
export const PAUSED_REREAD_MS = 2000;
/** Otherwise the delivered layer is refreshed this often. */
export const LAYER_REREAD_MS = 10_000;

export type RemoteVideoDelivery = {
  readonly publicationId: string;
  /** paused_for_network: the SFU stopped this video because the link cannot carry its lowest layer. Audio continues. */
  readonly state: "flowing" | "paused_for_network";
  /** The layer the SFU last said it forwards, when it said one. */
  readonly layer?: string;
};

/** A remote video the client receives, with what names its subscription on the SFU. */
export type DeliveredVideo = {
  readonly publicationId: string;
  readonly trackId: string;
  readonly mid: string;
  readonly sessionId: string;
  readonly trackName: string;
};

type Entry = {
  video: DeliveredVideo;
  quietSince: number | undefined;
  // When the newest completed read started. A read that started before a quiet began says nothing about it.
  verifiedAt: number | undefined;
  revision: number;
  state: SFUSubscriptionState | undefined;
};

const EMPTY: readonly RemoteVideoDelivery[] = Object.freeze([]);

/**
 * Tells a stall from a pause. A quiet video is held out of stall recovery until the SFU confirms it still sends it,
 * and a video the SFU paused stays held until RTP returns or the SFU resumes it: a repull cannot help a link that is
 * too slow for the lowest layer. One read is in flight at a time, and an older revision never replaces a newer one.
 */
export class SubscriptionDelivery {
  readonly #entries = new Map<string, Entry>();
  #reading = false;
  #lastReadAt = Number.NEGATIVE_INFINITY;
  #nextReadAt = Number.NEGATIVE_INFINITY;
  #deliveries: readonly RemoteVideoDelivery[] = EMPTY;

  /** Frozen; the same array until something a viewer can see changes. */
  get deliveries(): readonly RemoteVideoDelivery[] {
    return this.#deliveries;
  }

  get pausedForNetwork(): number {
    return this.#deliveries.filter((delivery) => delivery.state === "paused_for_network").length;
  }

  /** Feeds one stats sample: the videos still received and which of them received packets since the last sample. */
  observe(now: number, videos: readonly DeliveredVideo[], advanced: ReadonlySet<string>): void {
    const current = new Set(videos.map((video) => video.publicationId));
    for (const id of this.#entries.keys()) if (!current.has(id)) this.#entries.delete(id);
    for (const video of videos) {
      const entry = this.#entry(video);
      if (!advanced.has(video.publicationId)) {
        entry.quietSince ??= now;
        continue;
      }
      entry.quietSince = undefined;
      // Packets prove delivery, whatever an older read said.
      if (entry.state?.state === "paused") entry.state = { ...entry.state, state: "active" };
    }
    this.#publish();
  }

  /** True while a stall verdict for this publication would be wrong or premature. */
  held(publicationId: string): boolean {
    const entry = this.#entries.get(publicationId);
    if (!entry) return false;
    if (entry.state?.state === "paused") return true;
    return entry.quietSince !== undefined && (entry.verifiedAt === undefined || entry.verifiedAt < entry.quietSince);
  }

  needsRead(now: number): boolean {
    if (this.#reading || now < this.#nextReadAt || this.#entries.size === 0) return false;
    if (now - this.#lastReadAt >= LAYER_REREAD_MS) return true;
    for (const entry of this.#entries.values()) {
      if (entry.state?.state === "paused" && now - this.#lastReadAt >= PAUSED_REREAD_MS) return true;
      if (entry.quietSince !== undefined && now - entry.quietSince >= SUBSCRIPTION_READ_AFTER_QUIET_MS && (entry.verifiedAt === undefined || entry.verifiedAt < entry.quietSince)) return true;
    }
    return false;
  }

  /** Returns the read's start time, which `applied` and `failed` take back. */
  begin(now: number): number {
    this.#reading = true;
    this.#lastReadAt = now;
    return now;
  }

  /** Returns the publications the SFU resumed since the last read, whose receivers restart from a keyframe. */
  applied(startedAt: number, states: readonly SFUSubscriptionState[]): readonly string[] {
    this.#reading = false;
    const resumed: string[] = [];
    for (const [publicationId, entry] of this.#entries) {
      entry.verifiedAt = startedAt;
      const { mid, sessionId, trackName } = entry.video;
      const state = states.find((candidate) => candidate.mid === mid && candidate.sessionId === sessionId && candidate.trackName === trackName);
      // An equal revision is the SFU's current truth, so it can undo a pause that trailing packets cleared too early.
      if (!state || state.revision < entry.revision) continue;
      if (entry.state?.state === "paused" && state.state === "active") resumed.push(publicationId);
      entry.revision = state.revision;
      entry.state = state;
    }
    this.#publish();
    return resumed;
  }

  /** A failed read releases quiet videos to stall recovery. A pause the SFU reported stays until RTP or a read ends it. */
  failed(startedAt: number, now: number): void {
    this.#reading = false;
    this.#nextReadAt = now + PAUSED_REREAD_MS;
    for (const entry of this.#entries.values()) entry.verifiedAt = startedAt;
  }

  clear(): void {
    this.#entries.clear();
    this.#reading = false;
    this.#lastReadAt = Number.NEGATIVE_INFINITY;
    this.#nextReadAt = Number.NEGATIVE_INFINITY;
    this.#deliveries = EMPTY;
  }

  // A repull gives the publication a new receiver and a new subscription, whose revisions start again.
  #entry(video: DeliveredVideo): Entry {
    const previous = this.#entries.get(video.publicationId);
    if (previous && previous.video.trackId === video.trackId && previous.video.mid === video.mid) return previous;
    const entry: Entry = { video, quietSince: undefined, verifiedAt: undefined, revision: -1, state: undefined };
    this.#entries.set(video.publicationId, entry);
    return entry;
  }

  #publish(): void {
    const next = [...this.#entries.values()].flatMap(({ video, state }): RemoteVideoDelivery[] => {
      if (!state) return [];
      const paused = state.state === "paused" && state.reason === "congestion";
      return [{ publicationId: video.publicationId, state: paused ? "paused_for_network" : "flowing", ...(state.effectiveRid ? { layer: state.effectiveRid } : {}) }];
    });
    if (next.length === this.#deliveries.length && next.every((delivery, index) => deliveryEqual(delivery, this.#deliveries[index]))) return;
    this.#deliveries = next.length ? Object.freeze(next.map((delivery) => Object.freeze(delivery))) : EMPTY;
  }
}

function deliveryEqual(left: RemoteVideoDelivery, right: RemoteVideoDelivery | undefined): boolean {
  return left.publicationId === right?.publicationId && left.state === right.state && left.layer === right.layer;
}
