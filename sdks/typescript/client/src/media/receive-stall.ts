export const RECEIVE_STALL_WINDOW_MS = 20_000;
const MAX_SAMPLE_GAP_MS = 3000;

export type ReceivePacketSample = {
  readonly publicationId: string;
  readonly trackId: string;
  readonly packets: number;
};

/** Only consecutive, timely observations of expected media establish a stall. */
export class ReceiveStallDetector {
  readonly #progress = new Map<string, { trackId: string; packets: number; advancedAt: number }>();
  #sampledAt: number | undefined;

  forget(publicationId: string): void {
    this.#progress.delete(publicationId);
  }

  clear(): void {
    this.#progress.clear();
    this.#sampledAt = undefined;
  }

  sample(now: number, tracks: readonly ReceivePacketSample[]): readonly string[] {
    if (this.#sampledAt !== undefined && (now - this.#sampledAt > MAX_SAMPLE_GAP_MS || now < this.#sampledAt)) this.clear();
    this.#sampledAt = now;
    const observed = new Set(tracks.map((track) => track.publicationId));
    for (const id of this.#progress.keys()) if (!observed.has(id)) this.#progress.delete(id);
    const stalled: string[] = [];
    for (const { publicationId, trackId, packets } of tracks) {
      const previous = this.#progress.get(publicationId);
      if (!previous || previous.trackId !== trackId || previous.packets !== packets) {
        this.#progress.set(publicationId, { trackId, packets, advancedAt: now });
      } else if (now - previous.advancedAt >= RECEIVE_STALL_WINDOW_MS) {
        stalled.push(publicationId);
      }
    }
    return stalled;
  }
}
