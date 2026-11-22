import { DropList } from "./drops";
import { type Entry, EventQueue } from "./queue";
import type { SourceEnd, TelemetryCredential, WireEvent } from "./types";

const MAX_QUEUE_BYTES = 256 * 1024;

/** A batch is immutable from the moment it forms until its answer settles it: a retry sends the same body under the same `batch_id`. */
export type Batch = {
  readonly id: string;
  readonly entries: readonly Entry[];
  readonly subject: string | null;
  readonly body: string;
  readonly next: number;
  readonly end: SourceEnd | null;
};

/**
 * One source is one join: every record of it leaves under the credential of one subject (tenant, Episode and participant), the only one the server lets write it.
 * The live source takes new records. A retired source (an earlier join of this client, or a dead predecessor found in the journal) only sends what it holds, names its own drop list and reports its end. At most one batch of a source is in flight.
 */
export type Stream = {
  readonly id: string;
  live: boolean;
  /** The subject of the source, fixed by its first credential. */
  subject: string | null;
  /** The newest credential of the subject, so the records of a call that ended still leave under that call's credential. */
  credential: TelemetryCredential | null;
  readonly queue: EventQueue;
  /** The seqs of this source the client gave up on and has not yet named in a drop record of this source. */
  readonly drops: DropList;
  inflight: Batch | null;
  running: Promise<void> | null;
  /** The next seq. Exact for the live source, and the journal's for a predecessor. */
  next: number;
  /** The high-water mark the journal holds. */
  saved: number;
  closing: boolean;
  /** The end the client still owes the server for this source. */
  end: SourceEnd | null;
};

export const newStream = (id: string, live: boolean, subject: string | null = null): Stream => ({ id, live, subject, credential: null, queue: new EventQueue(MAX_QUEUE_BYTES), drops: new DropList(), inflight: null, running: null, next: 0, saved: 0, closing: false, end: null });

/** Every P0 record not yet settled, oldest first. The queue budget and the one batch in flight already bound them. */
export function heldRecords(stream: Stream): WireEvent[] {
  return [...(stream.inflight?.entries ?? []), ...stream.queue.entries()].filter((entry) => entry.priority === "p0").map((entry) => entry.event);
}
