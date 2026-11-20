import { PRIORITY, type Priority } from "./priority";
import type { TelemetryEvent } from "./types";

const MAX_MILLISECONDS = 2_147_483_647;

/** `subject` names the credential the event may leave under, and never changes. It is null until the first grant of the session names one. */
export type Entry = { readonly event: TelemetryEvent; readonly bytes: number; readonly priority: Priority; subject: string | null };

export function entryOf(event: TelemetryEvent, subject: string | null): Entry {
  return { event, bytes: sizeOf(event), priority: PRIORITY[event.type], subject };
}

export const isDropRecord = (entry: Entry): boolean => entry.event.type === "telemetry_dropped";

/**
 * Holds events in `seq` order under a byte budget. Routine and stats events may use at most half of it, and never push out a P0 event.
 * When it is full it gives up stats windows first (folding two into one keeps the newer), then routine events oldest first, and a P0 event only when nothing else is left.
 * Drop records are never given up. Events in a batch that is in flight are not in the queue.
 */
export class EventQueue {
  #entries: Entry[] = [];
  #bytes = 0;
  #p0Bytes = 0;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get length(): number {
    return this.#entries.length;
  }

  get hasDropRecord(): boolean {
    return this.#entries.some(isDropRecord);
  }

  /** The subject of the oldest event: undefined when the queue is empty, null when no grant has named one yet. */
  get headSubject(): string | null | undefined {
    return this.#entries[0]?.subject;
  }

  /** The subject of the newest event, on the same terms as `headSubject`. */
  get tailSubject(): string | null | undefined {
    return this.#entries.at(-1)?.subject;
  }

  entries(): readonly Entry[] {
    return this.#entries;
  }

  /** Returns what the byte budget cost. The new event may be among it. */
  push(entry: Entry): Entry[] {
    this.#insert(this.#entries.length, entry);
    return this.#fit();
  }

  /** Gives the events that came before any grant the subject of the first grant. Returns whether any changed. */
  adopt(subject: string): boolean {
    let changed = false;
    for (const entry of this.#entries) {
      if (entry.subject !== null) continue;
      entry.subject = subject;
      changed = true;
    }
    return changed;
  }

  /** Removes the oldest events of one subject that fit one request. Events of another subject wait for their own request. */
  take(maxEvents: number, maxBytes: number): Entry[] {
    const subject = this.headSubject;
    let count = 0;
    let bytes = 0;
    while (count < this.#entries.length && count < maxEvents && this.#entries[count]?.subject === subject) {
      const next = this.#entries[count]?.bytes ?? 0;
      if (count > 0 && bytes + next > maxBytes) break;
      bytes += next;
      count += 1;
    }
    return this.#entries.splice(0, count).map((entry) => this.#released(entry));
  }

  /** Puts events of a batch that was not fully settled back in front, where they were. Returns what the byte budget cost. */
  restore(entries: readonly Entry[]): Entry[] {
    entries.forEach((entry, index) => this.#insert(index, entry));
    return this.#fit();
  }

  /** Removes every event of one subject, for a credential that can no longer send them. */
  discard(subject: string | null): Entry[] {
    const lost = this.#entries.filter((entry) => entry.subject === subject);
    this.#entries = this.#entries.filter((entry) => entry.subject !== subject);
    for (const entry of lost) this.#released(entry);
    return lost;
  }

  #released(entry: Entry): Entry {
    this.#bytes -= entry.bytes;
    if (entry.priority === "p0") this.#p0Bytes -= entry.bytes;
    return entry;
  }

  #insert(index: number, entry: Entry): void {
    this.#entries.splice(index, 0, entry);
    this.#bytes += entry.bytes;
    if (entry.priority === "p0") this.#p0Bytes += entry.bytes;
  }

  #remove(entry: Entry): void {
    const index = this.#entries.indexOf(entry);
    if (index >= 0) this.#released(this.#entries.splice(index, 1)[0] ?? entry);
  }

  #fit(): Entry[] {
    const gone: Entry[] = [];
    for (;;) {
      const lowBytes = this.#bytes - this.#p0Bytes;
      const tooMuchLow = lowBytes > this.#maxBytes / 2;
      if (!tooMuchLow && this.#bytes <= this.#maxBytes) return gone;
      const victim = this.#victim();
      if (!victim) return gone;
      this.#evict(victim);
      gone.push(victim);
    }
  }

  /** Stats first, then routine oldest first, and a P0 event only when no other is held and the whole budget is spent. */
  #victim(): Entry | undefined {
    const stats = this.#entries.find((entry) => entry.priority === "stats");
    if (stats) return stats;
    const routine = this.#entries.find((entry) => entry.priority === "routine");
    if (routine) return routine;
    return this.#entries.find((entry) => entry.priority === "p0" && !isDropRecord(entry));
  }

  /** Giving up a stats window that has a later window of the same subject folds it into that one, which keeps its own seq. */
  #evict(victim: Entry): void {
    if (victim.priority === "stats") this.#foldInto(victim);
    this.#remove(victim);
  }

  #foldInto(older: Entry): void {
    const later = this.#entries.find((entry) => entry.priority === "stats" && entry.subject === older.subject && entry.event.seq > older.event.seq);
    if (!later) return;
    const windowMs = (older.event.stats?.window_ms ?? 0) + (later.event.stats?.window_ms ?? 0);
    const folded: TelemetryEvent = { ...later.event, stats: { window_ms: Math.max(1, Math.min(MAX_MILLISECONDS, windowMs)), gap: "dropped" } };
    const index = this.#entries.indexOf(later);
    this.#remove(later);
    this.#insert(index, entryOf(folded, later.subject));
  }
}

export function sizeOf(event: TelemetryEvent): number {
  return JSON.stringify(event).length + 1;
}
