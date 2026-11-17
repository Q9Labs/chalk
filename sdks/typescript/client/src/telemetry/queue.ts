import type { TelemetryEvent } from "./types";

const MAX_MILLISECONDS = 2_147_483_647;

/** `subject` names the credential the event may leave under, and never changes. It is null until the first grant of the session names one. */
type Entry = { readonly event: TelemetryEvent; readonly bytes: number; subject: string | null };

/** How many sequence numbers a lost batch leaves open. A lost `telemetry_dropped` event takes its own number with it, and the count it carried. */
export function lostBy(events: readonly TelemetryEvent[]): number {
  return events.reduce((sum, event) => sum + (event.type === "telemetry_dropped" ? (event.dropped ?? 0) + 1 : 1), 0);
}

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

  /** The subject of the oldest event: undefined when the queue is empty, null when no grant has named one yet. */
  get headSubject(): string | null | undefined {
    return this.#entries[0]?.subject;
  }

  /** The subject of the newest event, on the same terms as `headSubject`. */
  get tailSubject(): string | null | undefined {
    return this.#entries.at(-1)?.subject;
  }

  /** Returns how many events the byte budget cost. */
  push(event: TelemetryEvent, subject: string | null): number {
    this.#insert(this.#entries.length, { event, bytes: sizeOf(event), subject });
    return this.#fit();
  }

  /** Gives the events that came before any grant the subject of the first grant. */
  adopt(subject: string): void {
    for (const entry of this.#entries) entry.subject ??= subject;
  }

  /** Removes the oldest events of one subject that fit one request. Events of another subject wait for their own request. */
  take(maxEvents: number, maxBytes: number): TelemetryEvent[] {
    const subject = this.headSubject;
    let count = 0;
    let bytes = 0;
    while (count < this.#entries.length && count < maxEvents && this.#entries[count]?.subject === subject) {
      const next = this.#entries[count]?.bytes ?? 0;
      if (count > 0 && bytes + next > maxBytes) break;
      bytes += next;
      count += 1;
    }
    this.#bytes -= bytes;
    return this.#entries.splice(0, count).map((entry) => entry.event);
  }

  /** Puts a batch that was not accepted back in front, under the subject it was taken for. Returns how many events the byte budget cost. */
  restore(events: readonly TelemetryEvent[], subject: string | null): number {
    events.forEach((event, index) => this.#insert(index, { event, bytes: sizeOf(event), subject }));
    return this.#fit();
  }

  /** Removes every event of one subject, for a credential that can no longer send them. Returns how many events were lost. */
  discard(subject: string | null): number {
    const lost = this.#entries.filter((entry) => entry.subject === subject);
    this.#entries = this.#entries.filter((entry) => entry.subject !== subject);
    this.#bytes -= lost.reduce((sum, entry) => sum + entry.bytes, 0);
    return lostBy(lost.map((entry) => entry.event));
  }

  #insert(index: number, entry: Entry): void {
    this.#entries.splice(index, 0, entry);
    this.#bytes += entry.bytes;
  }

  #remove(index: number): Entry | undefined {
    const [removed] = this.#entries.splice(index, 1);
    if (removed) this.#bytes -= removed.bytes;
    return removed;
  }

  #fit(): number {
    let dropped = 0;
    while (this.#bytes > this.#maxBytes && this.#entries.length > 1) {
      const removed = this.#foldOldestStats() ? undefined : this.#remove(0);
      dropped += removed ? lostBy([removed.event]) : 1;
    }
    return dropped;
  }

  #foldOldestStats(): boolean {
    const [older, ...later] = this.#entries.filter((entry) => entry.event.type === "call_stats");
    const newer = later.find((entry) => entry.subject === older?.subject);
    if (!older || !newer) return false;
    const windowMs = (older.event.stats?.window_ms ?? 0) + (newer.event.stats?.window_ms ?? 0);
    const folded: TelemetryEvent = { ...older.event, stats: { window_ms: Math.max(1, Math.min(MAX_MILLISECONDS, windowMs)), gap: "dropped" } };
    const first = this.#entries.indexOf(older);
    this.#remove(this.#entries.indexOf(newer));
    this.#remove(first);
    this.#insert(first, { event: folded, bytes: sizeOf(folded), subject: older.subject });
    return true;
  }
}

function sizeOf(event: TelemetryEvent): number {
  return JSON.stringify(event).length + 1;
}
