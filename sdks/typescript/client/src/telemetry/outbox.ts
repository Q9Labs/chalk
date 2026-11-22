import { ClockEstimator } from "../obs/clock";
import { createKernel, type BuildInfo, type Kernel, type KernelMode, type ObsRecord } from "../obs/kernel";
import { startOperation } from "./operation";
import { entryOf } from "./queue";
import { newStream, type Stream } from "./stream";
import { StreamJournal } from "./stream-journal";
import { delayFor } from "./send-policy";
import { StreamSender } from "./stream-sender";
import type { DeliveryStep, MediaOperationResult, MediaOperationStart, PlatformChange, TelemetryCredentialSource, TelemetryDraft, TelemetryPlatform, TelemetrySink, WireEvent } from "./types";

/** Disposal names the drop list in as many records as it takes, but never loops on a frame the server keeps refusing. */
const MAX_DISPOSE_ROUNDS = 8;
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
  /** What the kernel stamps as the build. An SDK build that knows its version and Chalk environment passes them. */
  readonly build?: BuildInfo;
  /** The kernel's mode: open (the default) counts a registry violation and still sends the record, closed throws. */
  readonly obsMode?: KernelMode;
};

const DEFAULT_BUILD: BuildInfo = { module: "sdk", env: "production", platform: "web" };

/**
 * Everything the client tells the server about a call goes through here. One outbox belongs to one SDK client and lives from before its first join until the client is disposed.
 * `record` never throws and never refuses: a full queue gives up its least valuable events and names them in a `telemetry_dropped` record.
 * A P0 record is written to the platform's journal before `record` returns, and a reload of the same tab sends what the journal still holds.
 */
export class TelemetryOutbox implements TelemetrySink {
  readonly #platform: TelemetryPlatform;
  readonly #trace: ((step: DeliveryStep) => void) | undefined;
  readonly #realm: Set<string>;
  #live: Stream;
  /** Retired sources that still owe the server records, drop records or an end. */
  readonly #retired: Stream[] = [];
  readonly traceparent: string;
  /** The registry kernel of this client. Its records come here, and each takes the next seq of the live source. */
  readonly obs: Kernel;
  readonly #clientSessionId: string;
  readonly #startedAt: number;
  readonly #closing = new Set<() => void>();
  readonly #unsubscribe: () => void;
  readonly #journal: StreamJournal;
  readonly #sender: StreamSender;
  #source: TelemetryCredentialSource | null = null;
  #lastInterruption: { readonly reason: "offline" | "hidden"; readonly at: number } | null = null;
  #disposing = false;
  #disposed = false;

  constructor(options: TelemetryOutboxOptions) {
    const platform = options.platform;
    this.#platform = platform;
    this.#trace = options.trace;
    this.#realm = options.liveSources ?? liveInThisRealm;
    this.#live = newStream(platform.uuid(), true);
    this.#realm.add(this.#live.id);
    this.traceparent = `00-${hex(platform.uuid())}-${hex(platform.uuid()).slice(0, 16)}-01`;
    this.#clientSessionId = platform.uuid();
    const clock = new ClockEstimator({ mono: platform.now, wall: platform.wall ?? Date.now });
    this.obs = createKernel({ sink: (record) => this.#take(record), build: options.build ?? DEFAULT_BUILD, clock, trail: () => ({ client_session_id: this.#clientSessionId }), mode: options.obsMode ?? "open", uuid: platform.uuid });
    this.#startedAt = platform.now();
    const shared = { platform, disposed: () => this.#disposed, step: (step: DeliveryStep) => this.#step(step) };
    this.#journal = new StreamJournal({ ...shared, streams: () => this.#streams(), forget: (stream) => this.#forget(stream) });
    this.#sender = new StreamSender({
      ...shared,
      endpoint: options.endpoint,
      random: options.random ?? Math.random,
      traceparent: this.traceparent,
      clock,
      live: () => this.#live,
      source: () => this.#source,
      remember: () => this.#remember(),
      persist: (now, stream) => this.#persist(now, stream),
      stamp: (stream, draft) => this.#stamp(stream, draft),
      flush: () => this.flush(),
    });
    this.#takeOver();
    this.#unsubscribe = platform.subscribe((change) => this.#changed(change));
    if (this.#retired.length > 0) this.#sender.schedule(0);
  }

  /** The client session: this SDK client from its construction to its disposal, across every join. Every kernel record names it as `client_session_id`, and a problem report names it. */
  get clientSessionId(): string {
    return this.#clientSessionId;
  }

  /** The live source: the delivery stream of the current join, which owns its seqs. A new join starts a new one. */
  get sourceId(): string {
    return this.#live.id;
  }

  /** Whether the journal kept what it was last given. False where the platform has no journal. */
  get durable(): boolean {
    return this.#journal.durable;
  }

  /** Connects the outbox to the credential of the current join. Events recorded before this wait in the queue. */
  bind(source: TelemetryCredentialSource): void {
    this.#source = source;
    this.#remember();
    this.#sender.emitDrops(this.#live, true);
    if (this.#hasWork()) this.#sender.schedule(0);
  }

  /** Takes a record of the legacy vocabulary. New telemetry goes through `obs`, the kernel, instead. */
  record(draft: TelemetryDraft): void {
    this.#enqueue((stream) => this.#stamp(stream, draft));
  }

  /** The kernel's sink: the kernel made the record and its event_id, and the outbox gives it the live source's next seq. */
  #take(record: ObsRecord): void {
    this.#enqueue((stream) => {
      const event = { ...record, seq: stream.next };
      stream.next += 1;
      return event;
    });
  }

  #enqueue(stamp: (stream: Stream) => WireEvent): void {
    if (this.#disposed) return;
    this.#remember();
    const stream = this.#live;
    if (stream.closing) {
      stream.closing = false;
      this.#persist(true);
    }
    const entry = entryOf(stamp(stream), stream.subject);
    this.#step({ a: "record", src: stream.id, seq: entry.event.seq, p0: entry.priority === "p0" });
    this.#sender.giveUp(stream, stream.queue.push(entry), "queue_full", true);
    if (entry.priority === "p0") {
      stream.saved = stream.next;
      this.#persist(true);
    } else {
      this.#journal.armCheckpoint(stream);
    }
    this.#sender.schedule(delayFor(entry.event));
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
    await Promise.all(this.#streams().map((stream) => this.#sender.pump(stream)));
  }

  /** Names the drop list in a last record, sends everything once more, then tells the server this source is closed, with its exact `next_seq`. Later `record` calls do nothing. */
  async dispose(): Promise<void> {
    if (this.#disposing) return;
    this.#disposing = true;
    this.#unsubscribe();
    this.#sender.cancelTimer();
    this.#journal.cancelCheckpoint();
    this.#closing.clear();
    for (let round = 0; round < MAX_DISPOSE_ROUNDS && !this.#live.drops.empty; round++) {
      this.#sender.emitAllDrops();
      await this.flush();
    }
    this.#sender.emitAllDrops();
    const stream = this.#live;
    this.#disposed = true;
    stream.end = "closed";
    stream.closing = true;
    stream.saved = stream.next;
    this.#step({ a: "dispose", src: stream.id });
    this.#persist(true);
    try {
      await this.flush();
    } finally {
      this.#realm.delete(stream.id);
    }
  }

  #streams(): Stream[] {
    return [this.#live, ...this.#retired];
  }

  #step(step: DeliveryStep): void {
    this.#trace?.(step);
  }

  #persist(now: boolean, stream: Stream = this.#live): void {
    this.#journal.persist(now, stream);
  }

  #hasWork(): boolean {
    return this.#streams().some((stream) => stream.queue.length > 0 || stream.inflight !== null || stream.end !== null);
  }

  #stamp(stream: Stream, draft: TelemetryDraft): WireEvent {
    const event: WireEvent = { ...draft, seq: stream.next, event_id: this.#platform.uuid(), elapsed_ms: this.#elapsed() };
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
    if (change === "online") this.#sender.resume();
    else if (change === "offline") this.#lastInterruption = { reason: "offline", at: this.#platform.now() };
    else if (change === "hidden" || change === "background") {
      this.#lastInterruption = { reason: "hidden", at: this.#platform.now() };
      void this.flush();
    }
  }

  /** A credential of another subject is another join. The live source retires: it names its own drop list, then closes with its exact `next_seq`. The new join gets a new source that counts from 0. */
  #retire(): void {
    const old = this.#live;
    this.#journal.cancelCheckpoint();
    old.live = false;
    old.end = "closed";
    old.closing = true;
    old.saved = old.next;
    this.#live = newStream(this.#platform.uuid(), true);
    this.#realm.add(this.#live.id);
    this.#retired.push(old);
    this.#step({ a: "rejoin", src: old.id, next: this.#live.id });
    this.#persist(true, old);
    this.#sender.schedule(0);
  }

  /** A retired source that owes the server nothing more leaves the outbox and the realm. */
  #forget(stream: Stream): void {
    this.#retired.splice(this.#retired.indexOf(stream), 1);
    this.#realm.delete(stream.id);
  }

  /** Keeps the newest grant seen for each subject. A participant who left or failed to join has released the grant, but its credential is good until it expires. */
  #remember(): void {
    const credential = this.#source?.current();
    if (!credential || credential.expiresAt <= Date.now()) return;
    if (this.#live.subject !== null && this.#live.subject !== credential.subject) this.#retire();
    const stream = this.#live;
    stream.subject = credential.subject;
    const changed = stream.credential?.token !== credential.token;
    stream.credential = credential;
    if (changed) this.#persist(false);
    if (stream.queue.adopt(credential.subject)) this.#persist(false);
  }

  /** Takes over the journals of dead predecessors of this tab. A source still alive in this realm is skipped. */
  #takeOver(): void {
    const found = this.#journal.takeOver((id) => id === this.#live.id || this.#realm.has(id));
    if (found.length === 0) return;
    this.#retired.push(...found);
    this.#persist(true, this.#live);
    this.#step({ a: "reboot", src: this.#live.id });
  }
}

function hex(uuid: string): string {
  return uuid.replaceAll("-", "");
}
