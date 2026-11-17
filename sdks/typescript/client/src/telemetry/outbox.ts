import { startOperation } from "./operation";
import { EventQueue, lostBy } from "./queue";
import type { MediaOperationResult, MediaOperationStart, PlatformChange, PlatformState, TelemetryCredential, TelemetryCredentialSource, TelemetryDraft, TelemetryEvent, TelemetryPlatform, TelemetrySendResult, TelemetrySink } from "./types";

/** Events that say a bad thing may be starting go out at once, because the client may not live to send them later. */
const STARTED_PLATFORM_STATES: ReadonlySet<PlatformState | undefined> = new Set(["offline", "hidden", "background"]);
const ROUTINE_DELAY_MS = 1500;
const STATS_DELAY_MS = 30_000;
const AWAIT_CREDENTIAL_MS = 5000;
const MAX_BATCH_EVENTS = 100;
/** The server takes 64 KiB a request. Every request is sent with keepalive so a closing page cannot cancel it, and a keepalive request may not go over that. */
const MAX_BATCH_BYTES = 48 * 1024;
const MAX_QUEUE_BYTES = 256 * 1024;
const SEND_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const MAX_MILLISECONDS = 2_147_483_647;

export type TelemetryOutboxOptions = {
  readonly platform: TelemetryPlatform;
  readonly endpoint: (tenantId: string) => string;
  readonly random?: () => number;
};

/**
 * Everything the client tells the server about a call goes through here. One outbox belongs to one SDK client and lives from before its first join until the client is disposed.
 * `record` never throws and never refuses: a full queue folds old stats windows and counts what it had to drop.
 */
export class TelemetryOutbox implements TelemetrySink {
  readonly #platform: TelemetryPlatform;
  readonly #endpoint: (tenantId: string) => string;
  readonly #random: () => number;
  readonly #queue = new EventQueue(MAX_QUEUE_BYTES);
  readonly #sessionId: string;
  readonly traceparent: string;
  readonly #startedAt: number;
  readonly #closing = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #source: TelemetryCredentialSource | null = null;
  /** The newest credential seen for each subject, so events of a call that ended still leave under that call's credential. */
  readonly #credentials = new Map<string, TelemetryCredential>();
  #subject: string | null = null;
  #lastInterruption: { readonly reason: "offline" | "hidden"; readonly at: number } | null = null;
  #seq = 0;
  #dropped = 0;
  #failures = 0;
  #blockedUntil = 0;
  #timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #timerDue = 0;
  #running: Promise<void> | null = null;
  /** The subject whose credential was refreshed and has not been accepted since. One call's rejection never stops a later call from refreshing. */
  #refreshedSubject: string | null = null;
  #disposed = false;

  constructor(options: TelemetryOutboxOptions) {
    this.#platform = options.platform;
    this.#endpoint = options.endpoint;
    this.#random = options.random ?? Math.random;
    this.#sessionId = options.platform.uuid();
    this.traceparent = `00-${hex(options.platform.uuid())}-${hex(options.platform.uuid()).slice(0, 16)}-01`;
    this.#startedAt = options.platform.now();
    this.#unsubscribe = options.platform.subscribe((change) => this.#changed(change));
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  /** Connects the outbox to the credential of the current join. Events recorded before this wait in the queue. */
  bind(source: TelemetryCredentialSource): void {
    this.#source = source;
    this.#remember();
    if (this.#queue.length > 0) this.#schedule(0);
  }

  record(draft: TelemetryDraft): void {
    if (this.#disposed) return;
    this.#remember();
    const event = this.#stamp(draft);
    this.#dropped += this.#queue.push(event, this.#subject);
    this.#schedule(delayFor(event));
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

  /** Sends what is queued now, without waiting for a request already in flight, so a closing page loses nothing. Resolves when nothing more can be sent. */
  flush(): Promise<void> {
    return this.#loop();
  }

  /** Sends one last time and stops. Later `record` calls do nothing. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#unsubscribe();
    this.#cancelTimer();
    this.#closing.clear();
    const last = this.flush();
    this.#disposed = true;
    await last;
  }

  #stamp(draft: TelemetryDraft): TelemetryEvent {
    const event: TelemetryEvent = { ...draft, seq: this.#seq, elapsed_ms: this.#elapsed() };
    this.#seq += 1;
    return event;
  }

  #elapsed(): number {
    return Math.max(0, Math.min(MAX_MILLISECONDS, Math.round(this.#platform.now() - this.#startedAt)));
  }

  #changed(change: PlatformChange): void {
    if (change === "closing") {
      for (const handler of this.#closing) handler();
      void this.flush();
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
      void this.#drain();
    }, due - now);
  }

  #cancelTimer(): void {
    if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #drain(): Promise<void> {
    this.#running ??= this.#loop().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** One batch is in flight at a time per loop, so events leave in `seq` order. Every batch holds the events of one subject. */
  async #loop(): Promise<void> {
    for (;;) {
      this.#reportDrops();
      const credential = this.#sendable();
      if (!credential) return;
      const subject = credential.subject;
      const batch = this.#queue.take(MAX_BATCH_EVENTS, MAX_BATCH_BYTES);
      if ((await this.#settle(subject, batch, await this.#post(credential, batch))) === "stop") return;
    }
  }

  /** The credential for the oldest queued event, or null when nothing can be sent now. A subject whose credential is gone loses its events, and they are counted. */
  #sendable(): TelemetryCredential | null {
    this.#remember();
    for (;;) {
      const subject = this.#queue.headSubject;
      if (subject === undefined || !this.#platform.online()) return null;
      if (this.#platform.now() < this.#blockedUntil) {
        this.#schedule(0);
        return null;
      }
      // Before the first grant the outbox keeps asking: nothing yet says which credential these events belong to.
      if (subject === null) {
        this.#schedule(AWAIT_CREDENTIAL_MS);
        return null;
      }
      const credential = this.#credentials.get(subject);
      if (credential) return credential;
      this.#dropped += this.#queue.discard(subject);
    }
  }

  /** Decides what the answer to one batch means for the queue and for the next batch. */
  async #settle(subject: string, batch: readonly TelemetryEvent[], result: TelemetrySendResult | null): Promise<"continue" | "stop"> {
    const verdict = judge(result, subject !== this.#refreshedSubject, subject === this.#source?.current()?.subject);
    if (verdict === "retry") {
      this.#backoff(subject, batch, result?.retryAfterMs ?? 0);
      return "stop";
    }
    if (verdict === "accepted") {
      this.#failures = 0;
      if (this.#refreshedSubject === subject) this.#refreshedSubject = null;
    }
    if (verdict === "lost") this.#dropped += lostBy(batch);
    if (verdict === "refresh") {
      this.#refreshedSubject = subject;
      this.#restore(subject, batch);
      await this.#source?.refresh().catch(() => undefined);
    }
    return "continue";
  }

  async #post(credential: TelemetryCredential, events: readonly TelemetryEvent[]) {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      return await this.#platform.send({
        url: this.#endpoint(credential.tenantId),
        token: credential.token,
        traceparent: this.traceparent,
        body: JSON.stringify({ version: 1, client_session_id: this.#sessionId, events }),
        keepalive: true,
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /** Puts the batch back and waits, with full jitter, for as long as the server asked or the failures call for. */
  #backoff(subject: string, batch: readonly TelemetryEvent[], retryAfterMs: number): void {
    this.#restore(subject, batch);
    this.#failures += 1;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.#failures, 10));
    const delay = Math.max(retryAfterMs, this.#random() * ceiling);
    this.#blockedUntil = this.#platform.now() + delay;
    this.#schedule(delay);
  }

  #restore(subject: string, batch: readonly TelemetryEvent[]): void {
    this.#dropped += this.#queue.restore(batch, subject);
  }

  /** The next batch of real events says how many events this client lost, so the server can tell a hole in `seq` from a bug. A loss alone never causes a request. */
  #reportDrops(): void {
    const tail = this.#queue.tailSubject;
    if (this.#dropped === 0 || tail === undefined) return;
    const dropped = Math.min(this.#dropped, MAX_MILLISECONDS);
    this.#dropped = 0;
    this.#dropped += this.#queue.push(this.#stamp({ type: "telemetry_dropped", dropped }), tail);
  }

  /** Keeps the newest grant seen for each subject. A participant who left or failed to join has released the grant, but its credential is good until it expires. */
  #remember(): void {
    const credential = this.#source?.current();
    for (const [subject, kept] of this.#credentials) if (kept.expiresAt <= Date.now()) this.#credentials.delete(subject);
    if (!credential || credential.expiresAt <= Date.now()) return;
    this.#credentials.set(credential.subject, credential);
    this.#subject = credential.subject;
    this.#queue.adopt(credential.subject);
  }
}

type Verdict = "accepted" | "refresh" | "retry" | "lost";

/** Only the current grant can be refreshed, and only once until a request succeeds, so a rejected credential of an earlier call is gone for good. */
function judge(result: TelemetrySendResult | null, canRefresh: boolean, current: boolean): Verdict {
  if (result === null) return "retry";
  if (result.status >= 200 && result.status < 300) return "accepted";
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
