// fallow-ignore-file complexity -- every branch is a delivery step; the outbox delivery tests and the formal trace replay cover each one, which the CRAP estimate cannot see.
import type { ClockEstimator } from "../obs/clock";
import { countOf, seqsOf } from "./drops";
import { type Entry, entryOf, isDropRecord, legacyOf } from "./queue";
import { judge } from "./send-policy";
import type { Batch, Stream } from "./stream";
import type { DeliveryStep, DropReason, LedgerFrame, SeqRange, TelemetryCredential, TelemetryCredentialSource, TelemetryDraft, TelemetryPlatform, TelemetrySendResult, WireEvent } from "./types";

const AWAIT_CREDENTIAL_MS = 5000;
const MAX_BATCH_EVENTS = 100;
const MAX_DROP_RANGES = 64;
/** The server takes 64 KiB a request. Every request is sent with keepalive so a closing page cannot cancel it, and a keepalive request may not go over that. */
const MAX_BATCH_BYTES = 48 * 1024;
const SEND_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/** What the sender needs from the outbox that owns the sources. */
export type SenderHost = {
  readonly platform: TelemetryPlatform;
  readonly endpoint: (tenantId: string) => string;
  readonly random: () => number;
  readonly traceparent: string;
  readonly clock: ClockEstimator;
  live(): Stream;
  source(): TelemetryCredentialSource | null;
  disposed(): boolean;
  /** Takes in the newest grant, which may retire the live source. */
  remember(): void;
  persist(now: boolean, stream: Stream): void;
  stamp(stream: Stream, draft: TelemetryDraft): WireEvent;
  step(step: DeliveryStep): void;
  flush(): Promise<void>;
};

/** Sends each source's records in batches, one batch of a source in flight at a time, and settles them by the server's answers. It owns the drain timer and the backoff. */
export class StreamSender {
  readonly #host: SenderHost;
  #failures = 0;
  #blockedUntil = 0;
  #timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #timerDue = 0;
  /** The subject whose credential was refreshed and has not been accepted since. One call's rejection never stops a later call from refreshing. */
  #refreshedSubject: string | null = null;

  constructor(host: SenderHost) {
    this.#host = host;
  }

  resume(): void {
    this.#failures = 0;
    this.#blockedUntil = 0;
    this.schedule(0);
  }

  /** A drain never fires before `#blockedUntil`, so a new event cannot replace the wake-up a backoff set. */
  schedule(delayMs: number): void {
    if (this.#host.disposed()) return;
    const now = this.#host.platform.now();
    const due = Math.max(now + delayMs, this.#blockedUntil);
    if (this.#timer !== null && this.#timerDue <= due) return;
    this.cancelTimer();
    this.#timerDue = due;
    this.#timer = globalThis.setTimeout(() => {
      this.#timer = null;
      void this.#host.flush();
    }, due - now);
  }

  cancelTimer(): void {
    if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
    this.#timer = null;
  }

  pump(stream: Stream): Promise<void> {
    stream.running ??= this.#run(stream).finally(() => {
      stream.running = null;
    });
    return stream.running;
  }

  /** One batch of the source is in flight at a time, so its events leave in `seq` order. Every batch holds the events of one subject. */
  async #run(stream: Stream): Promise<void> {
    for (;;) {
      this.emitDrops(stream, !stream.live, !stream.live);
      const next = this.#nextBatch(stream);
      if (!next) return;
      const result = await this.#post(stream, next.credential, next.batch);
      if ((await this.#settle(stream, next.batch, result)) === "stop") return;
    }
  }

  /**
   * The batch to send now, with the credential it leaves under, or null when nothing can be sent. When the live source's credential is gone its events are given up and named in its drop list.
   * A retired source whose credential is gone can send nothing more, not even its end, so it is abandoned and the server keeps its gap open.
   */
  #nextBatch(stream: Stream): { readonly batch: Batch; readonly credential: TelemetryCredential } | null {
    this.#host.remember();
    for (;;) {
      const held = stream.inflight;
      const empty = !held && stream.queue.length === 0;
      if (empty && stream.end === null) return null;
      const subject = held ? held.subject : empty ? stream.subject : stream.queue.headSubject;
      if (this.#waits(stream, subject)) return null;
      const credential = subject === stream.subject ? this.#credentialFor(stream) : undefined;
      if (credential && subject) return { batch: held ?? this.#form(stream, subject), credential };
      if (!stream.live) {
        this.#abandon(stream);
        return null;
      }
      if (empty || !subject) return null;
      this.#giveUpSubject(stream, subject);
    }
  }

  /** Whether the source must wait to send: offline, backing off, or live with no grant yet. Each case schedules the try it needs. */
  #waits(stream: Stream, subject: string | null | undefined): boolean {
    if (!this.#host.platform.online()) return true;
    if (this.#host.platform.now() < this.#blockedUntil) {
      this.schedule(0);
      return true;
    }
    // Before the first grant the outbox keeps asking: nothing yet says which credential these events belong to.
    if (stream.live && (subject === null || subject === undefined)) {
      this.schedule(AWAIT_CREDENTIAL_MS);
      return true;
    }
    return false;
  }

  /** The journal's high-water mark is saved before the batch leaves, so an abandoned end a successor reports from it is never below a `next_seq` the server has seen. */
  #form(stream: Stream, subject: string): Batch {
    if (stream.saved < stream.next) {
      stream.saved = stream.next;
      this.#host.persist(true, stream);
    }
    const entries = stream.queue.take(MAX_BATCH_EVENTS, MAX_BATCH_BYTES);
    const end = stream.queue.length === 0 ? stream.end : null;
    const id = this.#host.platform.uuid();
    const request: LedgerFrame = { version: 2, source_id: stream.id, batch_id: id, next_seq: stream.next, ...(end ? { end } : {}), events: entries.map((entry) => entry.event) };
    const batch: Batch = { id, entries, subject, body: JSON.stringify(request), next: stream.next, end };
    stream.inflight = batch;
    return batch;
  }

  /** A retired source's saved credential is replaced by the live source's when both speak for the same subject and the live one lasts longer. */
  #credentialFor(stream: Stream): TelemetryCredential | undefined {
    const own = stream.credential ?? undefined;
    const live = this.#host.live();
    const current = live !== stream && live.subject === stream.subject ? (live.credential ?? undefined) : undefined;
    const best = own && current ? (current.expiresAt > own.expiresAt ? current : own) : (own ?? current);
    return best && best.expiresAt > Date.now() ? best : undefined;
  }

  #giveUpSubject(stream: Stream, subject: string): void {
    if (stream.inflight?.subject === subject) {
      const held = stream.inflight;
      stream.inflight = null;
      this.giveUp(stream, held.entries, "credential_expired", false);
    }
    this.giveUp(stream, stream.queue.discard(subject), "credential_expired", false);
  }

  async #post(stream: Stream, credential: TelemetryCredential, batch: Batch): Promise<TelemetrySendResult | null> {
    const host = this.#host;
    host.step({ a: "send", src: stream.id, batch: batch.id, seqs: batch.entries.map((entry) => entry.event.seq), next: batch.next, end: batch.end ?? "" });
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const sent = host.platform.now();
      const result = await host.platform.send({ url: host.endpoint(credential.tenantId), token: credential.token, traceparent: host.traceparent, body: batch.body, keepalive: true, signal: controller.signal });
      if (result.serverMs !== undefined) host.clock.sample(sent, host.platform.now(), result.serverMs);
      return result;
    } catch {
      return null;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /** Decides what the answer to one batch means for the source and for the next batch. Only the seqs `acks` names are settled. */
  async #settle(stream: Stream, batch: Batch, result: TelemetrySendResult | null): Promise<"continue" | "stop"> {
    const subject = batch.subject;
    const current = subject !== null && subject === this.#host.source()?.current()?.subject;
    const verdict = judge(result, subject !== this.#refreshedSubject, current);
    if (verdict === "retry" || verdict === "refresh") return this.#again(stream, batch, verdict, result);
    if (verdict === "lost" && !stream.live) {
      this.#abandon(stream);
      return "continue";
    }
    stream.inflight = null;
    if (verdict === "accepted") {
      this.#failures = 0;
      if (this.#refreshedSubject === subject) this.#refreshedSubject = null;
      this.#settleAcked(stream, batch, result?.acks ?? []);
    } else {
      if (batch.entries.length === 0) stream.end = null;
      this.giveUp(stream, batch.entries, result?.status === 401 ? "credential_expired" : "refused", false);
    }
    this.#host.persist(false, stream);
    return "continue";
  }

  /** A batch that will be sent again: after a backoff for a retry, or at once under a refreshed credential. */
  async #again(stream: Stream, batch: Batch, verdict: "retry" | "refresh", result: TelemetrySendResult | null): Promise<"continue" | "stop"> {
    this.#host.step({ a: "timeout", src: stream.id, batch: batch.id });
    if (verdict === "retry") {
      this.#backoff(result?.retryAfterMs ?? 0);
      return "stop";
    }
    this.#refreshedSubject = batch.subject;
    await this.#host
      .source()
      ?.refresh()
      .catch(() => undefined);
    return "continue";
  }

  #settleAcked(stream: Stream, batch: Batch, acks: readonly SeqRange[]): void {
    const settled = batch.entries.filter((entry) => acks.some((range) => entry.event.seq >= range.from && entry.event.seq < range.to));
    this.#host.step({ a: "ack", src: stream.id, batch: batch.id, acks: settled.map((entry) => entry.event.seq) });
    if (batch.end !== null) stream.end = null;
    this.giveUp(stream, stream.queue.restore(batch.entries.filter((entry) => !settled.includes(entry))), "queue_full", true);
  }

  /** Waits, with full jitter, for as long as the server asked or the failures call for. The batch stays as it is. */
  #backoff(retryAfterMs: number): void {
    this.#failures += 1;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.#failures, 10));
    const delay = Math.max(retryAfterMs, this.#host.random() * ceiling);
    this.#blockedUntil = this.#host.platform.now() + delay;
    this.schedule(delay);
  }

  /**
   * Every record the client gives up joins the drop list, so a `telemetry_dropped` record can name it. A drop record that is given up names its own seq and returns what it covered.
   * `evicted` marks the queue's own choice, which the model knows as `evict`.
   */
  giveUp(stream: Stream, entries: readonly Entry[], reason: DropReason, evicted: boolean): void {
    for (const entry of entries) {
      const event = entry.event;
      const drop = legacyOf(event);
      if (drop && isDropRecord(entry)) for (const range of drop.dropped_seqs ?? []) stream.drops.addRange(range, drop.drop_reason ?? reason);
      stream.drops.add(event.seq, reason);
      if (evicted) this.#host.step({ a: "evict", src: stream.id, seq: event.seq });
    }
    if (entries.length > 0) this.#host.persist(true, stream);
  }

  /** A retired source whose credential is gone or refused gives up everything it still owes: the server keeps its missing seqs and its open tail as gaps. */
  #abandon(stream: Stream): void {
    stream.inflight = null;
    stream.queue.discard(stream.subject);
    stream.queue.discard(null);
    stream.drops.clear();
    stream.end = null;
    this.#host.step({ a: "abandon", src: stream.id });
    this.#host.persist(true, stream);
  }

  /** At disposal no later drain will name the drop list, so it all becomes drop records now, unsettled ones or not. */
  emitAllDrops(): void {
    let more = true;
    while (more) more = this.emitDrops(this.#host.live(), true, true);
  }

  /**
   * A source's drop list becomes one `telemetry_dropped` record of that source: one reason, at most 64 ranges, all below the record's seq, and never while an earlier drop record is unsettled unless the source is closing. Without `force` it waits for a real record to travel with.
   * A retired source names its drop list only when its high-water mark is exact (it closed), because only then is no seq it mints one its dead page already used.
   */
  emitDrops(stream: Stream, force: boolean, closing = false): boolean {
    if ((stream.live && this.#host.disposed()) || stream.drops.empty || (!force && stream.queue.length === 0) || (!closing && dropRecordUnsettled(stream))) return false;
    const group = stream.drops.take(MAX_DROP_RANGES);
    if (!group) return false;
    const draft: TelemetryDraft = { type: "telemetry_dropped", dropped: countOf(group.ranges), dropped_seqs: [...group.ranges], drop_reason: group.reason };
    if (stream.live) this.#host.remember();
    const entry = entryOf(this.#host.stamp(stream, draft), stream.queue.tailSubject ?? stream.subject);
    this.#host.step({ a: "emit_drop", src: stream.id, seq: entry.event.seq, covers: seqsOf(group.ranges).map((seq): [string, number] => [stream.id, seq]) });
    this.giveUp(stream, stream.queue.push(entry), "queue_full", true);
    stream.saved = stream.next;
    this.#host.persist(true, stream);
    return true;
  }
}

function dropRecordUnsettled(stream: Stream): boolean {
  return stream.queue.hasDropRecord || (stream.inflight?.entries.some(isDropRecord) ?? false);
}
