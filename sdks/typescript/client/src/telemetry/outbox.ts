import { EventQueue } from "./queue";
import type { PlatformChange, PlatformState, TelemetryCredential, TelemetryCredentialSource, TelemetryDraft, TelemetryEvent, TelemetryPlatform, TelemetrySink } from "./types";

/** Events that say a bad thing may be starting go out at once, because the client may not live to send them later. */
const STARTED_PLATFORM_STATES: ReadonlySet<PlatformState | undefined> = new Set(["offline", "hidden", "background"]);
const ROUTINE_DELAY_MS = 1500;
const STATS_DELAY_MS = 30_000;
const AWAIT_CREDENTIAL_MS = 5000;
const MAX_BATCH_EVENTS = 100;
/** The server takes 64 KiB a request, and a keepalive request may not go over that. */
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
  #lastCredential: TelemetryCredential | null = null;
  #lastInterruption: { readonly reason: "offline" | "hidden"; readonly at: number } | null = null;
  #seq = 0;
  #dropped = 0;
  #failures = 0;
  #blockedUntil = 0;
  #timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #timerDue = 0;
  #running: Promise<void> | null = null;
  #keepalive = false;
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
    const event: TelemetryEvent = { ...draft, seq: this.#seq, elapsed_ms: this.#elapsed() };
    this.#seq += 1;
    this.#dropped += this.#queue.push(event);
    this.#schedule(delayFor(event));
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

  /** Sends what is queued now, with keepalive so the request outlives a closing page. Resolves when nothing more can be sent. */
  flush(): Promise<void> {
    this.#keepalive = true;
    return this.#drain();
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
    if (change === "offline" || change === "hidden" || change === "background") this.#lastInterruption = { reason: change === "offline" ? "offline" : "hidden", at: this.#platform.now() };
    if (change !== "online") return;
    this.#failures = 0;
    this.#blockedUntil = 0;
    this.#schedule(0);
  }

  #schedule(delayMs: number): void {
    if (this.#disposed) return;
    const due = this.#platform.now() + delayMs;
    if (this.#timer !== null && this.#timerDue <= due) return;
    this.#cancelTimer();
    this.#timerDue = due;
    this.#timer = globalThis.setTimeout(() => {
      this.#timer = null;
      void this.#drain();
    }, delayMs);
  }

  #cancelTimer(): void {
    if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #drain(): Promise<void> {
    this.#running ??= this.#loop().finally(() => {
      this.#running = null;
      this.#keepalive = false;
    });
    return this.#running;
  }

  /** One batch is in flight at a time, so events leave in `seq` order. */
  async #loop(): Promise<void> {
    let refreshed = false;
    for (;;) {
      this.#reportDrops();
      const credential = this.#credential();
      if (this.#queue.length === 0 || !this.#platform.online() || this.#platform.now() < this.#blockedUntil) return;
      if (!credential) {
        // Before the first grant the outbox keeps asking. Once it has had a credential and lost it, nothing will bring one back.
        if (!this.#lastCredential) this.#schedule(AWAIT_CREDENTIAL_MS);
        return;
      }
      const batch = this.#queue.take(MAX_BATCH_EVENTS, MAX_BATCH_BYTES);
      const result = await this.#post(credential, batch);
      if (result === null) {
        this.#backoff(batch, 0);
        return;
      }
      if (result.status >= 200 && result.status < 300) {
        this.#failures = 0;
      } else if (result.status === 401 && !refreshed) {
        refreshed = true;
        this.#dropped += this.#queue.restore(batch);
        await this.#source?.refresh().catch(() => undefined);
        continue;
      } else if (result.status === 429 || result.status >= 500) {
        this.#backoff(batch, result.retryAfterMs);
        return;
      } else {
        this.#dropped += batch.length;
      }
      refreshed = false;
    }
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
        keepalive: this.#keepalive,
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /** Puts the batch back and waits, with full jitter, for as long as the server asked or the failures call for. */
  #backoff(batch: readonly TelemetryEvent[], retryAfterMs: number): void {
    this.#dropped += this.#queue.restore(batch);
    this.#failures += 1;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.#failures, 10));
    const delay = Math.max(retryAfterMs, this.#random() * ceiling);
    this.#blockedUntil = this.#platform.now() + delay;
    this.#schedule(delay);
  }

  /** The next batch says how many events this client lost, so the server can tell a hole in `seq` from a bug. */
  #reportDrops(): void {
    if (this.#dropped === 0) return;
    const dropped = Math.min(this.#dropped, MAX_MILLISECONDS);
    this.#dropped = 0;
    this.record({ type: "telemetry_dropped", dropped });
  }

  /** Keeps the newest grant seen. A participant who left or failed to join has released the grant, but its credential is good until it expires. */
  #remember(): void {
    this.#lastCredential = this.#source?.current() ?? this.#lastCredential;
  }

  #credential(): TelemetryCredential | null {
    this.#remember();
    const credential = this.#lastCredential;
    return credential && credential.expiresAt > Date.now() ? credential : null;
  }
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
