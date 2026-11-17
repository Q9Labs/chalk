import type { TelemetryEvent } from "./types";

const MAX_MILLISECONDS = 2_147_483_647;

type Entry = { readonly event: TelemetryEvent; readonly bytes: number };

/** Holds events in `seq` order under a byte budget. When it is full it folds the oldest stats windows into one gap window, and drops an event only when no two windows are left to fold. */
export class EventQueue {
  #entries: Entry[] = [];
  #bytes = 0;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get length(): number {
    return this.#entries.length;
  }

  /** Returns how many events the byte budget cost. */
  push(event: TelemetryEvent): number {
    this.#insert(this.#entries.length, { event, bytes: sizeOf(event) });
    return this.#fit();
  }

  /** Removes the oldest events that fit one request. */
  take(maxEvents: number, maxBytes: number): TelemetryEvent[] {
    let count = 0;
    let bytes = 0;
    while (count < this.#entries.length && count < maxEvents) {
      const next = this.#entries[count]?.bytes ?? 0;
      if (count > 0 && bytes + next > maxBytes) break;
      bytes += next;
      count += 1;
    }
    this.#bytes -= bytes;
    return this.#entries.splice(0, count).map((entry) => entry.event);
  }

  /** Puts a batch that was not accepted back in front. Returns how many events the byte budget cost. */
  restore(events: readonly TelemetryEvent[]): number {
    events.forEach((event, index) => this.#insert(index, { event, bytes: sizeOf(event) }));
    return this.#fit();
  }

  #insert(index: number, entry: Entry): void {
    this.#entries.splice(index, 0, entry);
    this.#bytes += entry.bytes;
  }

  #remove(index: number): void {
    const [removed] = this.#entries.splice(index, 1);
    if (removed) this.#bytes -= removed.bytes;
  }

  #fit(): number {
    let dropped = 0;
    while (this.#bytes > this.#maxBytes && this.#entries.length > 1) {
      if (!this.#foldOldestStats()) this.#remove(0);
      dropped += 1;
    }
    return dropped;
  }

  #foldOldestStats(): boolean {
    const [older, newer] = this.#entries.filter((entry) => entry.event.type === "call_stats");
    if (!older || !newer) return false;
    const windowMs = (older.event.stats?.window_ms ?? 0) + (newer.event.stats?.window_ms ?? 0);
    const folded: TelemetryEvent = { ...older.event, stats: { window_ms: Math.max(1, Math.min(MAX_MILLISECONDS, windowMs)), gap: "dropped" } };
    const first = this.#entries.indexOf(older);
    this.#remove(this.#entries.indexOf(newer));
    this.#remove(first);
    this.#insert(first, { event: folded, bytes: sizeOf(folded) });
    return true;
  }
}

function sizeOf(event: TelemetryEvent): number {
  return JSON.stringify(event).length + 1;
}
