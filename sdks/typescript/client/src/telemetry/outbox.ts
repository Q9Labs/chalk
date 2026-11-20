import { countOf, DropList, seqsOf } from "./drops";
import { readJournalText, writeJournalText } from "./journal";
import { startOperation } from "./operation";
import { type Entry, EventQueue, entryOf, isDropRecord } from "./queue";
import type {
  DeliveryStep,
  DropReason,
  MediaOperationResult,
  MediaOperationStart,
  PlatformChange,
  PlatformState,
  SeqRange,
  SourceEnd,
  TelemetryCredential,
  TelemetryCredentialSource,
  TelemetryDraft,
  TelemetryEvent,
  TelemetryPlatform,
  TelemetryRequest,
  TelemetrySendResult,
  TelemetrySink,
} from "./types";

/** Events that say a bad thing may be starting go out at once, because the client may not live to send them later. */
const STARTED_PLATFORM_STATES: ReadonlySet<PlatformState | undefined> = new Set(["offline", "hidden", "background"]);
const ROUTINE_DELAY_MS = 1500;
const STATS_DELAY_MS = 30_000;
const AWAIT_CREDENTIAL_MS = 5000;
const CHECKPOINT_MS = 5000;
const MAX_BATCH_EVENTS = 100;
const MAX_DROP_RANGES = 64;
/** Disposal names the drop list in as many records as it takes, but never loops on a frame the server keeps refusing. */
const MAX_DISPOSE_ROUNDS = 8;
/** The server takes 64 KiB a request. Every request is sent with keepalive so a closing page cannot cancel it, and a keepalive request may not go over that. */
const MAX_BATCH_BYTES = 48 * 1024;
const MAX_QUEUE_BYTES = 256 * 1024;
/** The journal holds P0 records only, and no more of them than the P0 share of the queue. */
const MAX_JOURNAL_RECORD_BYTES = MAX_QUEUE_BYTES / 2;
const SEND_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const MAX_MILLISECONDS = 2_147_483_647;

/** The source ids of the outboxes alive in this JS realm, so one tab with two clients never takes a live client's journal for a dead one's. */
const liveInThisRealm = new Set<string>();

export type TelemetryOutboxOptions = {
  readonly platform: TelemetryPlatform;
  readonly endpoint: (tenantId: string) => string;
  readonly random?: () => number;
  /** Internal: called synchronously at each step of the delivery model, for the trace check. Not part of the SDK surface. */
  readonly trace?: (step: DeliveryStep) => void;
  /** Internal: replaces the realm-wide set of live source ids. A test uses a fresh set to stand for a new page. */
  readonly liveSources?: Set<string>;
};

/** A batch is immutable from the moment it forms until its answer settles it: a retry sends the same body under the same `batch_id`. */
type Batch = {
  readonly id: string;
  readonly entries: readonly Entry[];
  readonly subject: string | null;
  readonly body: string;
  readonly next: number;
  readonly end: SourceEnd | null;
};

/** One source: this client's own, or a dead predecessor's whose records and end this client sends. At most one batch of a source is in flight. */
type Stream = {
  readonly id: string;
  readonly live: boolean;
  readonly queue: EventQueue;
  /** The newest credential seen for each subject, so events of a call that ended still leave under that call's credential. */
  readonly credentials: Map<string, TelemetryCredential>;
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

const newStream = (id: string, live: boolean): Stream => ({ id, live, queue: new EventQueue(MAX_QUEUE_BYTES), credentials: new Map(), inflight: null, running: null, next: 0, saved: 0, closing: false, end: null });

/**
 * Everything the client tells the server about a call goes through here. One outbox belongs to one SDK client and lives from before its first join until the client is disposed.
 * `record` never throws and never refuses: a full queue gives up its least valuable events and names them in a `telemetry_dropped` record.
 * A P0 record is written to the platform's journal before `record` returns, and a reload of the same tab sends what the journal still holds.
 */
export class TelemetryOutbox implements TelemetrySink {
  readonly #platform: TelemetryPlatform;
  readonly #endpoint: (tenantId: string) => string;
  readonly #random: () => number;
  readonly #trace: ((step: DeliveryStep) => void) | undefined;
  readonly #realm: Set<string>;
  readonly #live: Stream;
  readonly #predecessors: Stream[] = [];
  readonly #drops = new DropList();
  readonly traceparent: string;
  readonly #startedAt: number;
  readonly #closing = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #source: TelemetryCredentialSource | null = null;
  #subject: string | null = null;
  #lastInterruption: { readonly reason: "offline" | "hidden"; readonly at: number } | null = null;
  #failures = 0;
  #blockedUntil = 0;
  #timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #timerDue = 0;
  #checkpointTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  readonly #dirty = new Set<Stream>();
  #writePending = false;
  #durable = false;
  /** The subject whose credential was refreshed and has not been accepted since. One call's rejection never stops a later call from refreshing. */
  #refreshedSubject: string | null = null;
  #disposing = false;
  #disposed = false;

  constructor(options: TelemetryOutboxOptions) {
    this.#platform = options.platform;
    this.#endpoint = options.endpoint;
    this.#random = options.random ?? Math.random;
    this.#trace = options.trace;
    this.#realm = options.liveSources ?? liveInThisRealm;
    this.#live = newStream(options.platform.uuid(), true);
    this.#realm.add(this.#live.id);
    this.traceparent = `00-${hex(options.platform.uuid())}-${hex(options.platform.uuid()).slice(0, 16)}-01`;
    this.#startedAt = options.platform.now();
    this.#takeOver();
    this.#unsubscribe = options.platform.subscribe((change) => this.#changed(change));
    if (this.#predecessors.length > 0) this.#schedule(0);
  }

  get sessionId(): string {
    return this.#live.id;
  }

  /** Whether the journal kept what it was last given. False where the platform has no journal. */
  get durable(): boolean {
    return this.#durable;
  }

  /** Connects the outbox to the credential of the current join. Events recorded before this wait in the queue. */
  bind(source: TelemetryCredentialSource): void {
    this.#source = source;
    this.#remember();
    this.#emitDrops(true);
    if (this.#hasWork()) this.#schedule(0);
  }

  record(draft: TelemetryDraft): void {
    if (this.#disposed) return;
    const stream = this.#live;
    this.#remember();
    if (stream.closing) {
      stream.closing = false;
      this.#persist(true);
    }
    const entry = entryOf(this.#stamp(draft), this.#subject);
    this.#step({ a: "record", src: stream.id, seq: entry.event.seq, p0: entry.priority === "p0" });
    this.#giveUp(stream, stream.queue.push(entry), "queue_full", true);
    if (entry.priority === "p0") {
      stream.saved = stream.next;
      this.#persist(true);
    } else {
      this.#armCheckpoint();
    }
    this.#schedule(delayFor(entry.event));
  }

  operation(start: MediaOperationStart): (result: MediaOperationResult) => void {
    return startOperation((draft) => this.record(draft), this.#platform, start);
  }

  interruption(withinMs: number): "offline" | "hidden" | null {
    if (!this.#platform.online()) return "offline";
    if (this.#platform.hidden()) return "hidden";
    const last = this.#lastInterruption;
    return last && this.#platform.now() - last.at <= withinMs ? last.reason : null;
  }

  /** Runs `handler` when the page is going away, before the last flush, so the call can say how it ended. */
  onClosing(handler: () => void): () => void {
    this.#closing.add(handler);
    return () => this.#closing.delete(handler);
  }

  /** Sends what is queued now. A source with a batch in flight waits for its answer first: one batch per source is in flight. Resolves when nothing more can be sent. */
  async flush(): Promise<void> {
    await Promise.all(this.#streams().map((stream) => this.#pump(stream)));
  }

  /** Names the drop list in a last record, sends everything once more, then tells the server this source is closed, with its exact `next_seq`. Later `record` calls do nothing. */
  async dispose(): Promise<void> {
    if (this.#disposing) return;
    this.#disposing = true;
    this.#unsubscribe();
    this.#cancelTimer();
    this.#cancelCheckpoint();
    this.#closing.clear();
    for (let round = 0; round < MAX_DISPOSE_ROUNDS && !this.#drops.empty; round++) {
      this.#emitAllDrops();
      await this.flush();
    }
    this.#emitAllDrops();
    const stream = this.#live;
    this.#disposed = true;
    stream.end = "closed";
    stream.closing = true;
    stream.saved = stream.next;
    this.#realm.delete(stream.id);
    this.#step({ a: "dispose", src: stream.id });
    this.#persist(true);
    await this.flush();
  }

  #streams(): Stream[] {
    return [this.#live, ...this.#predecessors];
  }

  #step(step: DeliveryStep): void {
    this.#trace?.(step);
  }

  #hasWork(): boolean {
    return this.#streams().some((stream) => stream.queue.length > 0 || stream.inflight !== null || stream.end !== null);
  }

  #stamp(draft: TelemetryDraft): TelemetryEvent {
    const stream = this.#live;
    const event: TelemetryEvent = { ...draft, seq: stream.next, event_id: this.#platform.uuid(), elapsed_ms: this.#elapsed() };
    stream.next += 1;
    return event;
  }

  #elapsed(): number {
    return Math.max(0, Math.min(MAX_MILLISECONDS, Math.round(this.#platform.now() - this.#startedAt)));
  }

  #changed(change: PlatformChange): void {
    if (change === "closing") {
      for (const handler of this.#closing) handler();
      void this.flush();
      const stream = this.#live;
      stream.closing = true;
      stream.saved = stream.next;
      this.#persist(true);
      this.#step({ a: "pagehide" });
      return;
    }
    this.record({ type: "platform_changed", platform_state: change });
    if (change === "online") this.#resume();
    else if (change === "offline") this.#lastInterruption = { reason: "offline", at: this.#platform.now() };
    else if (change === "hidden" || change === "background") {
      this.#lastInterruption = { reason: "hidden", at: this.#platform.now() };
      void this.flush();
    }
  }

  #resume(): void {
    this.#failures = 0;
    this.#blockedUntil = 0;
    this.#schedule(0);
  }

  /** A drain never fires before `#blockedUntil`, so a new event cannot replace the wake-up a backoff set. */
  #schedule(delayMs: number): void {
    if (this.#disposed) return;
    const now = this.#platform.now();
    const due = Math.max(now + delayMs, this.#blockedUntil);
    if (this.#timer !== null && this.#timerDue <= due) return;
    this.#cancelTimer();
    this.#timerDue = due;
    this.#timer = globalThis.setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, due - now);
  }

  #cancelTimer(): void {
    if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #pump(stream: Stream): Promise<void> {
    stream.running ??= this.#run(stream).finally(() => {
      stream.running = null;
    });
    return stream.running;
  }

  /** One batch of the source is in flight at a time, so its events leave in `seq` order. Every batch holds the events of one subject. */
  async #run(stream: Stream): Promise<void> {
    for (;;) {
      if (stream.live) this.#emitDrops(false);
      const next = this.#nextBatch(stream);
      if (!next) return;
      const result = await this.#post(stream, next.credential, next.batch);
      if ((await this.#settle(stream, next.batch, result)) === "stop") return;
    }
  }

  /** The batch to send now, with the credential it leaves under, or null when nothing can be sent. A subject whose credential is gone loses its events, and they are named in the drop list. */
  #nextBatch(stream: Stream): { readonly batch: Batch; readonly credential: TelemetryCredential } | null {
    this.#remember();
    for (;;) {
      const held = stream.inflight;
      const empty = !held && stream.queue.length === 0;
      if (empty && stream.end === null) return null;
      const subject = held ? held.subject : empty ? this.#endSubject(stream) : stream.queue.headSubject;
      if (!this.#platform.online()) return null;
      if (this.#platform.now() < this.#blockedUntil) {
        this.#schedule(0);
        return null;
      }
      // Before the first grant the outbox keeps asking: nothing yet says which credential these events belong to.
      if (subject === null || subject === undefined) {
        this.#schedule(AWAIT_CREDENTIAL_MS);
        return null;
      }
      const credential = this.#credentialFor(stream, subject);
      if (credential) return { batch: held ?? this.#form(stream, subject), credential };
      if (empty) return null;
      this.#giveUpSubject(stream, subject);
    }
  }

  #form(stream: Stream, subject: string): Batch {
    const entries = stream.queue.take(MAX_BATCH_EVENTS, MAX_BATCH_BYTES);
    const end = stream.queue.length === 0 ? stream.end : null;
    const id = this.#platform.uuid();
    const request: TelemetryRequest = { version: 2, source_id: stream.id, batch_id: id, next_seq: stream.next, ...(end ? { end } : {}), events: entries.map((entry) => entry.event) };
    const batch: Batch = { id, entries, subject, body: JSON.stringify(request), next: stream.next, end };
    stream.inflight = batch;
    return batch;
  }

  /** The credential for an end with no events: any the source still holds, and failing that the current call's. */
  #endSubject(stream: Stream): string | null {
    const held = [...stream.credentials.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
    return held?.subject ?? this.#subject;
  }

  /** A predecessor's saved credential is replaced by this client's own for the same subject when that one lasts longer. */
  #credentialFor(stream: Stream, subject: string): TelemetryCredential | undefined {
    const own = stream.credentials.get(subject);
    const current = this.#live.credentials.get(subject);
    const best = own && current ? (current.expiresAt > own.expiresAt ? current : own) : (own ?? current);
    return best && best.expiresAt > Date.now() ? best : undefined;
  }

  #giveUpSubject(stream: Stream, subject: string): void {
    if (stream.inflight?.subject === subject) {
      const held = stream.inflight;
      stream.inflight = null;
      this.#giveUp(stream, held.entries, "credential_expired", false);
    }
    this.#giveUp(stream, stream.queue.discard(subject), "credential_expired", false);
  }

  async #post(stream: Stream, credential: TelemetryCredential, batch: Batch): Promise<TelemetrySendResult | null> {
    this.#step({ a: "send", src: stream.id, batch: batch.id, seqs: batch.entries.map((entry) => entry.event.seq), next: batch.next, end: batch.end ?? "" });
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      return await this.#platform.send({
        url: this.#endpoint(credential.tenantId),
        token: credential.token,
        traceparent: this.traceparent,
        body: batch.body,
        keepalive: true,
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /** Decides what the answer to one batch means for the source and for the next batch. Only the seqs `acks` names are settled. */
  async #settle(stream: Stream, batch: Batch, result: TelemetrySendResult | null): Promise<"continue" | "stop"> {
    const subject = batch.subject;
    const current = subject !== null && subject === this.#source?.current()?.subject;
    const verdict = judge(result, subject !== this.#refreshedSubject, current);
    if (verdict === "retry") {
      this.#step({ a: "timeout", src: stream.id, batch: batch.id });
      this.#backoff(result?.retryAfterMs ?? 0);
      return "stop";
    }
    if (verdict === "refresh") {
      this.#step({ a: "timeout", src: stream.id, batch: batch.id });
      this.#refreshedSubject = subject;
      await this.#source?.refresh().catch(() => undefined);
      return "continue";
    }
    stream.inflight = null;
    if (verdict === "accepted") {
      this.#failures = 0;
      if (this.#refreshedSubject === subject) this.#refreshedSubject = null;
      this.#settleAcked(stream, batch, result?.acks ?? []);
    } else {
      if (batch.entries.length === 0) stream.end = null;
      this.#giveUp(stream, batch.entries, result?.status === 401 ? "credential_expired" : "refused", false);
    }
    this.#persist(false, stream);
    return "continue";
  }

  #settleAcked(stream: Stream, batch: Batch, acks: readonly SeqRange[]): void {
    const settled = batch.entries.filter((entry) => acks.some((range) => entry.event.seq >= range.from && entry.event.seq < range.to));
    this.#step({ a: "ack", src: stream.id, batch: batch.id, acks: settled.map((entry) => entry.event.seq) });
    if (batch.end !== null) stream.end = null;
    this.#giveUp(stream, stream.queue.restore(batch.entries.filter((entry) => !settled.includes(entry))), "queue_full", true);
  }

  /** Waits, with full jitter, for as long as the server asked or the failures call for. The batch stays as it is. */
  #backoff(retryAfterMs: number): void {
    this.#failures += 1;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.#failures, 10));
    const delay = Math.max(retryAfterMs, this.#random() * ceiling);
    this.#blockedUntil = this.#platform.now() + delay;
    this.#schedule(delay);
  }

  /**
   * Every record the client gives up joins the drop list, so a `telemetry_dropped` record can name it. A drop record that is given up names its own seq and returns what it covered.
   * `evicted` marks the queue's own choice, which the model knows as `evict`.
   */
  #giveUp(stream: Stream, entries: readonly Entry[], reason: DropReason, evicted: boolean): void {
    for (const entry of entries) {
      const event = entry.event;
      if (isDropRecord(entry)) for (const range of event.dropped_seqs ?? []) this.#drops.addRange(event.dropped_source_id ?? stream.id, range, event.drop_reason ?? reason);
      this.#drops.add(stream.id, event.seq, reason);
      if (evicted) this.#step({ a: "evict", src: stream.id, seq: event.seq });
    }
    if (entries.length > 0) this.#persist(true);
  }

  /** At disposal no later drain will name the drop list, so it all becomes drop records now, unsettled ones or not. */
  #emitAllDrops(): void {
    let more = true;
    while (more) more = this.#emitDrops(true, true);
  }

  /** The drop list becomes one `telemetry_dropped` record: one source and one reason, at most 64 ranges, and never while an earlier drop record is unsettled unless the source is closing. Without `force` it waits for a real record to travel with. */
  #emitDrops(force: boolean, closing = false): boolean {
    const stream = this.#live;
    if (this.#disposed || this.#drops.empty || (!force && stream.queue.length === 0) || (!closing && this.#dropRecordUnsettled())) return false;
    const group = this.#drops.take(MAX_DROP_RANGES);
    if (!group) return false;
    const draft: TelemetryDraft = {
      type: "telemetry_dropped",
      dropped: countOf(group.ranges),
      dropped_seqs: [...group.ranges],
      drop_reason: group.reason,
      ...(group.source === stream.id ? {} : { dropped_source_id: group.source }),
    };
    this.#remember();
    const entry = entryOf(this.#stamp(draft), stream.queue.tailSubject ?? this.#subject);
    this.#step({ a: "emit_drop", src: stream.id, seq: entry.event.seq, covers: seqsOf(group.ranges).map((seq): [string, number] => [group.source, seq]) });
    this.#giveUp(stream, stream.queue.push(entry), "queue_full", true);
    stream.saved = stream.next;
    this.#persist(true);
    return true;
  }

  #dropRecordUnsettled(): boolean {
    const stream = this.#live;
    return stream.queue.hasDropRecord || (stream.inflight?.entries.some(isDropRecord) ?? false);
  }

  /** Keeps the newest grant seen for each subject. A participant who left or failed to join has released the grant, but its credential is good until it expires. */
  #remember(): void {
    const stream = this.#live;
    for (const [subject, kept] of stream.credentials) if (kept.expiresAt <= Date.now()) stream.credentials.delete(subject);
    const credential = this.#source?.current();
    if (!credential || credential.expiresAt <= Date.now()) return;
    if (stream.credentials.get(credential.subject)?.token !== credential.token) this.#persist(false);
    stream.credentials.set(credential.subject, credential);
    this.#subject = credential.subject;
    if (stream.queue.adopt(credential.subject)) this.#persist(false);
  }

  /** Saves the high-water mark at most every 5 seconds, so a reload can say how far this source got even if it never recorded a P0 record. */
  #armCheckpoint(): void {
    const stream = this.#live;
    if (!this.#platform.journal || this.#checkpointTimer !== null || stream.saved === stream.next) return;
    this.#checkpointTimer = globalThis.setTimeout(() => {
      this.#checkpointTimer = null;
      if (this.#disposed || stream.saved === stream.next) return;
      stream.saved = stream.next;
      this.#persist(true);
      this.#step({ a: "checkpoint", src: stream.id, next: stream.next });
    }, CHECKPOINT_MS);
  }

  #cancelCheckpoint(): void {
    if (this.#checkpointTimer !== null) globalThis.clearTimeout(this.#checkpointTimer);
    this.#checkpointTimer = null;
  }

  /** Marks a source's journal for writing. `now` writes before returning, which a P0 record and a closing mark need. The rest is written once, in the next microtask. */
  #persist(now: boolean, stream: Stream = this.#live): void {
    if (!this.#platform.journal) return;
    this.#dirty.add(stream);
    if (now) {
      this.#writeJournals();
      return;
    }
    if (this.#writePending) return;
    this.#writePending = true;
    void Promise.resolve().then(() => {
      this.#writePending = false;
      this.#writeJournals();
    });
  }

  /** The live source is written before any predecessor, so a drop list taken over is saved before the predecessor forgets it. */
  #writeJournals(): void {
    const journal = this.#platform.journal;
    if (!journal) return;
    const dirty = this.#streams().filter((stream) => this.#dirty.has(stream));
    this.#dirty.clear();
    for (const stream of dirty) {
      if (this.#finished(stream)) {
        journal.remove(stream.id);
        if (!stream.live) this.#predecessors.splice(this.#predecessors.indexOf(stream), 1);
        continue;
      }
      const records = this.#heldRecords(stream);
      if (stream.live && stream.saved === 0 && records.length === 0 && this.#drops.empty) continue;
      this.#durable = journal.save(
        stream.id,
        writeJournalText({
          version: 1,
          sourceId: stream.id,
          next: stream.saved,
          closing: stream.closing,
          end: stream.end,
          credentials: [...stream.credentials.values()].filter((credential) => credential.expiresAt > Date.now()),
          records,
          drops: stream.live ? this.#drops.groups() : [],
        }),
      );
    }
  }

  #finished(stream: Stream): boolean {
    if (stream.inflight || stream.queue.length > 0 || stream.end !== null) return false;
    return stream.live ? this.#disposed && this.#drops.empty : true;
  }

  /** The P0 records not yet settled, oldest first, as many as the journal's share of the budget holds. A record that does not fit is held in memory only. */
  #heldRecords(stream: Stream): { readonly event: TelemetryEvent; readonly subject: string | null }[] {
    const held = [...(stream.inflight?.entries ?? []), ...stream.queue.entries()].filter((entry) => entry.priority === "p0");
    let bytes = 0;
    const kept: { readonly event: TelemetryEvent; readonly subject: string | null }[] = [];
    for (const entry of held) {
      bytes += entry.bytes;
      if (bytes > MAX_JOURNAL_RECORD_BYTES) break;
      kept.push({ event: entry.event, subject: entry.subject });
    }
    return kept;
  }

  /** Reads the journals of other sources: dead predecessors of this tab, which this client sends for and ends. A source still alive in this realm is skipped. */
  #takeOver(): void {
    const journal = this.#platform.journal;
    if (!journal) return;
    const ids = journalIds(journal);
    for (const id of ids) {
      if (id === this.#live.id || this.#realm.has(id)) continue;
      const text = journal.load(id);
      const saved = text === null ? null : readJournalText(text);
      if (!saved || saved.sourceId !== id) {
        journal.remove(id);
        continue;
      }
      const stream = newStream(id, false);
      stream.next = saved.next;
      stream.saved = saved.next;
      stream.closing = saved.closing;
      stream.end = saved.end ?? (saved.closing ? "closed" : "abandoned");
      for (const credential of saved.credentials) stream.credentials.set(credential.subject, credential);
      for (const { event, subject } of saved.records) stream.queue.push(entryOf(event, subject));
      this.#drops.merge(saved.drops);
      this.#giveUp(stream, stream.queue.discard(null), "credential_expired", false);
      this.#predecessors.push(stream);
      this.#dirty.add(stream);
    }
    if (this.#predecessors.length === 0) return;
    this.#persist(true, this.#live);
    this.#step({ a: "reboot", src: this.#live.id });
  }
}

function journalIds(journal: NonNullable<TelemetryPlatform["journal"]>): readonly string[] {
  try {
    return journal.list();
  } catch {
    return [];
  }
}

type Verdict = "accepted" | "refresh" | "retry" | "lost";

/** Only the current grant can be refreshed, and only once until a request succeeds, so a rejected credential of an earlier call is gone for good. A status settles nothing: only a 2xx answer that names its acks does. */
function judge(result: TelemetrySendResult | null, canRefresh: boolean, current: boolean): Verdict {
  if (result === null) return "retry";
  if (result.status >= 200 && result.status < 300) return result.acks ? "accepted" : "retry";
  if (result.status === 401) return !current ? "lost" : canRefresh ? "refresh" : "retry";
  return result.status === 429 || result.status >= 500 ? "retry" : "lost";
}

function hex(uuid: string): string {
  return uuid.replaceAll("-", "");
}

function delayFor(event: TelemetryEvent): number {
  if (event.type === "call_stats") return STATS_DELAY_MS;
  if (event.type === "platform_changed" && STARTED_PLATFORM_STATES.has(event.platform_state)) return 0;
  if (event.type === "space_join_span" && event.outcome === "started") return 0;
  return ROUTINE_DELAY_MS;
}
