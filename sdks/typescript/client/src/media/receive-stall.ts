export const RECEIVE_STALL_WINDOW_MS = 7000;
export const RECEIVE_STARTUP_GRACE_MS = 20_000;
const MAX_SAMPLE_GAP_MS = 3000;

export type ReceivePacketSample = {
  readonly publicationId: string;
  readonly trackId: string;
  readonly packets: number;
};

/** Only consecutive, timely observations of expected media establish a stall. */
export class ReceiveStallDetector {
  readonly #progress = new Map<string, { trackId: string; packets: number; advancedAt: number; flowing: boolean }>();
  #sampledAt: number | undefined;

  forget(publicationId: string): void {
    this.#progress.delete(publicationId);
  }

  clear(): void {
    this.#progress.clear();
    this.#sampledAt = undefined;
  }

  sample(now: number, tracks: readonly ReceivePacketSample[]): { readonly stalled: readonly string[]; readonly advanced: readonly string[] } {
    if (this.#sampledAt !== undefined && (now - this.#sampledAt > MAX_SAMPLE_GAP_MS || now < this.#sampledAt)) this.clear();
    this.#sampledAt = now;
    const observed = new Set(tracks.map((track) => track.publicationId));
    for (const id of this.#progress.keys()) if (!observed.has(id)) this.#progress.delete(id);
    const observations = tracks.map((track) => ({ id: track.publicationId, outcome: this.#observeTrack(now, track) }));
    return {
      stalled: observations.filter((track) => track.outcome === "stalled").map((track) => track.id),
      advanced: observations.filter((track) => track.outcome === "advanced").map((track) => track.id),
    };
  }

  #observeTrack(now: number, { publicationId, trackId, packets }: ReceivePacketSample): "stalled" | "advanced" | null {
    const previous = this.#progress.get(publicationId);
    const sameTrack = previous?.trackId === trackId;
    if (sameTrack && previous.packets === packets) {
      const window = previous.flowing ? RECEIVE_STALL_WINDOW_MS : RECEIVE_STARTUP_GRACE_MS;
      return now - previous.advancedAt >= window ? "stalled" : null;
    }
    this.#progress.set(publicationId, { trackId, packets, advancedAt: now, flowing: sameTrack && packets > previous.packets });
    return sameTrack && packets > previous.packets ? "advanced" : null;
  }
}
