// fallow-ignore-file complexity -- every branch is a delivery step; the outbox delivery tests and the formal trace replay cover each one, which the CRAP estimate cannot see.
import { readJournalText, writeJournalText } from "./journal";
import { entryOf } from "./queue";
import { heldRecords, newStream, type Stream } from "./stream";
import type { DeliveryStep, TelemetryPlatform } from "./types";

const CHECKPOINT_MS = 5000;

/** What the journal needs from the outbox that owns the sources. */
export type JournalHost = {
  readonly platform: TelemetryPlatform;
  /** Every source the outbox holds, the live one first. */
  streams(): readonly Stream[];
  disposed(): boolean;
  /** Drops a retired source that owes the server nothing more. */
  forget(stream: Stream): void;
  step(step: DeliveryStep): void;
};

/** Keeps each source's journal on the platform, so a reload of the same tab can send what a dead page still held and end its source. */
export class StreamJournal {
  readonly #host: JournalHost;
  readonly #dirty = new Set<Stream>();
  #writePending = false;
  #checkpointTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  /** Whether the journal kept what it was last given. False where the platform has no journal. */
  durable = false;

  constructor(host: JournalHost) {
    this.#host = host;
  }

  /** Marks a source's journal for writing. `now` writes before returning, which a P0 record and a closing mark need. The rest is written once, in the next microtask. */
  persist(now: boolean, stream: Stream): void {
    if (!this.#host.platform.journal) return;
    this.#dirty.add(stream);
    if (now) {
      this.#write();
      return;
    }
    if (this.#writePending) return;
    this.#writePending = true;
    void Promise.resolve().then(() => {
      this.#writePending = false;
      this.#write();
    });
  }

  /** Saves the high-water mark at most every 5 seconds, so a reload can say how far this source got even if it never recorded a P0 record. */
  armCheckpoint(stream: Stream): void {
    if (!this.#host.platform.journal || this.#checkpointTimer !== null || stream.saved === stream.next) return;
    this.#checkpointTimer = globalThis.setTimeout(() => {
      this.#checkpointTimer = null;
      if (this.#host.disposed() || stream.saved === stream.next) return;
      stream.saved = stream.next;
      this.persist(true, stream);
      this.#host.step({ a: "checkpoint", src: stream.id, next: stream.next });
    }, CHECKPOINT_MS);
  }

  cancelCheckpoint(): void {
    if (this.#checkpointTimer !== null) globalThis.clearTimeout(this.#checkpointTimer);
    this.#checkpointTimer = null;
  }

  /** Reads the journals of other sources: dead predecessors of this tab, which this client sends for under their own credentials and ends. A source `alive` names is skipped. */
  takeOver(alive: (id: string) => boolean): Stream[] {
    const journal = this.#host.platform.journal;
    if (!journal) return [];
    const found: Stream[] = [];
    for (const id of journalIds(journal)) {
      if (alive(id)) continue;
      const text = journal.load(id);
      const saved = text === null ? null : readJournalText(text);
      if (!saved || saved.sourceId !== id) {
        journal.remove(id);
        continue;
      }
      const stream = newStream(id, false, saved.subject);
      stream.credential = saved.credential;
      stream.next = saved.next;
      stream.saved = saved.next;
      stream.closing = saved.closing;
      stream.end = saved.end ?? (saved.closing ? "closed" : "abandoned");
      for (const event of saved.records) stream.queue.push(entryOf(event, saved.subject));
      // An abandoned source's high-water mark is only a lower bound, so a drop record minted at it could take the seq of a record its page made and lost. Its drop list is left unsent: those seqs stay missing, which reads as unchecked.
      if (saved.closing) stream.drops.merge(saved.drops);
      found.push(stream);
      this.#dirty.add(stream);
    }
    return found;
  }

  /** Writes the journal of each marked source, and removes the journal of a source that owes nothing more. */
  #write(): void {
    const journal = this.#host.platform.journal;
    if (!journal) return;
    const dirty = this.#host.streams().filter((stream) => this.#dirty.has(stream));
    this.#dirty.clear();
    for (const stream of dirty) {
      if (this.#finished(stream)) {
        journal.remove(stream.id);
        if (!stream.live) this.#host.forget(stream);
        continue;
      }
      const records = heldRecords(stream);
      if (stream.live && stream.saved === 0 && records.length === 0 && stream.drops.empty) continue;
      const credential = stream.credential && stream.credential.expiresAt > Date.now() ? stream.credential : null;
      this.durable = journal.save(stream.id, writeJournalText({ version: 2, sourceId: stream.id, subject: stream.subject, next: stream.saved, closing: stream.closing, end: stream.end, credential, records, drops: stream.drops.groups() }));
    }
  }

  #finished(stream: Stream): boolean {
    if (stream.inflight || stream.queue.length > 0 || stream.end !== null) return false;
    return stream.drops.empty && (!stream.live || this.#host.disposed());
  }
}

function journalIds(journal: NonNullable<TelemetryPlatform["journal"]>): readonly string[] {
  try {
    return journal.list();
  } catch {
    return [];
  }
}
