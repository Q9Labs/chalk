import { TelemetryOutbox } from "./outbox";
import type { DeliveryStep, PlatformChange, SeqRange, TelemetryEvent, TelemetryPlatform, TelemetryRequest, TelemetrySendResult } from "./types";
import { createSessionJournal } from "./web-platform";

/** What the trace holds: the outbox's own steps, plus what the test harness and the protocol double did. */
export type TraceStep =
  | DeliveryStep
  | { readonly a: "crash" }
  | { readonly a: "receive"; readonly batch: string; readonly settle: readonly number[] }
  | { readonly a: "write" }
  | { readonly a: "commit" }
  | { readonly a: "respond" }
  | { readonly a: "server_crash" }
  | { readonly a: "lose_request"; readonly batch: string }
  | { readonly a: "lose_answer"; readonly batch: string };

/** What goes wrong with the next request that reaches the double. `settle` settles only those seqs of the batch. */
export type Fault = "lose_request" | "lose_answer" | "crash" | "unavailable" | { readonly settle: readonly number[] };

type SourceLedger = { readonly stored: Set<number>; readonly dropped: Set<number>; reported: number; end: "" | "closed" | "abandoned"; endNext: number };

/** A tab's sessionStorage, which a reload keeps. */
export class MemoryStorage {
  readonly #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
}

/** The server rules of docs/telemetry-delivery.md: a ledger keyed by source and seq, dedupe, answers that name the settled seqs, and a sink write before the ledger commit. */
export class ProtocolDouble {
  readonly ledgers = new Map<string, SourceLedger>();
  /** Every row the sink got. A crash between the write and the commit makes the retry write a row twice. */
  readonly rows: { readonly source: string; readonly event: TelemetryEvent }[] = [];
  readonly requests: TelemetryRequest[] = [];
  readonly faults: Fault[] = [];
  readonly #emit: (step: TraceStep) => void;

  constructor(emit: (step: TraceStep) => void) {
    this.#emit = emit;
  }

  ledger(source: string): SourceLedger {
    let found = this.ledgers.get(source);
    if (!found) {
      found = { stored: new Set(), dropped: new Set(), reported: 0, end: "", endNext: 0 };
      this.ledgers.set(source, found);
    }
    return found;
  }

  /** The records as the reader sees them: copies of one `(source_id, seq)` collapse to one. */
  stored(): Map<string, TelemetryEvent> {
    return new Map(this.rows.map((row) => [`${row.source}/${row.event.seq}`, row.event]));
  }

  handle(body: TelemetryRequest, signal: AbortSignal): Promise<TelemetrySendResult> {
    this.requests.push(body);
    const fault = this.faults.shift();
    const batch = body.batch_id ?? "";
    const seqs = body.events.map((event) => event.seq);
    if (fault === "lose_request") {
      this.#emit({ a: "lose_request", batch });
      return never(signal);
    }
    if (fault === "unavailable") {
      this.#emit({ a: "lose_request", batch });
      return Promise.resolve({ status: 503, retryAfterMs: 0 });
    }
    const settle = typeof fault === "object" ? seqs.filter((seq) => fault.settle.includes(seq)) : seqs;
    this.#emit({ a: "receive", batch, settle });
    const source = body.source_id ?? "";
    const ledger = this.ledger(source);
    const fresh = body.events.filter((event) => settle.includes(event.seq) && !ledger.stored.has(event.seq));
    this.rows.push(...fresh.map((event) => ({ source, event })));
    this.#emit({ a: "write" });
    if (fault === "crash") {
      this.#emit({ a: "server_crash" });
      return Promise.reject(new TypeError("the server died"));
    }
    for (const event of fresh) {
      ledger.stored.add(event.seq);
      for (const range of event.dropped_seqs ?? []) for (let seq = range.from; seq < range.to; seq++) this.ledger(event.dropped_source_id ?? source).dropped.add(seq);
    }
    ledger.reported = Math.max(ledger.reported, body.next_seq ?? 0);
    if (body.end && ledger.end !== "closed") {
      ledger.end = body.end;
      ledger.endNext = body.next_seq ?? 0;
    }
    this.#emit({ a: "commit" });
    this.#emit({ a: "respond" });
    if (fault === "lose_answer") {
      this.#emit({ a: "lose_answer", batch });
      return never(signal);
    }
    return Promise.resolve({ status: 200, retryAfterMs: 0, acks: settle.map((seq): SeqRange => ({ from: seq, to: seq + 1 })) });
  }
}

/** A request whose answer never comes: the outbox gives up when its send timeout aborts it. */
function never(signal: AbortSignal): Promise<TelemetrySendResult> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new TypeError("aborted"))));
}

export const credential = () => ({ tenantId: "tenant", subject: "tenant/episode/participant", token: "token", expiresAt: Date.now() + 3_600_000 });

/** One tab on one device: a sessionStorage the boots share, one server, and the trace of both. */
export function createWorld(scenario: string) {
  const steps: TraceStep[] = [];
  const storage = new MemoryStorage();
  const server = new ProtocolDouble((step) => steps.push(step));
  let ids = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

  /** One run of the page: a new outbox over the tab's journal. `crash` abandons it with no disposal, as a killed page would. */
  const boot = (options: { readonly bind?: boolean; readonly liveSources?: Set<string> } = {}) => {
    const state = { dead: false, online: true };
    const listeners = new Set<(change: PlatformChange) => void>();
    const shared = createSessionJournal(() => storage);
    const platform: TelemetryPlatform = {
      now: () => Date.now(),
      uuid,
      online: () => state.online,
      hidden: () => false,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: (request) => {
        if (state.dead) return new Promise(() => undefined);
        const body: TelemetryRequest = JSON.parse(request.body);
        return server.handle(body, request.signal);
      },
      journal: {
        list: () => (state.dead ? [] : shared.list()),
        load: (id) => (state.dead ? null : shared.load(id)),
        save: (id, text) => !state.dead && shared.save(id, text),
        remove: (id) => (state.dead ? undefined : shared.remove(id)),
      },
    };
    const outbox = new TelemetryOutbox({
      platform,
      endpoint: (tenantId) => `https://api.test/v1/tenants/${tenantId}/telemetry`,
      random: () => 0.5,
      trace: (step) => {
        if (!state.dead) steps.push(step);
      },
      liveSources: options.liveSources ?? new Set(),
    });
    if (options.bind !== false) outbox.bind({ current: credential, refresh: async () => undefined });
    return {
      outbox,
      state,
      crash: () => {
        steps.push({ a: "crash" });
        state.dead = true;
      },
      /** The platform says `closing`. The model's PageHide step ends the page by itself, so `gone` retires the outbox without a `crash` step. */
      pagehide: () => {
        for (const listener of [...listeners]) listener("closing");
      },
      gone: () => {
        state.dead = true;
      },
    };
  };

  return { scenario, steps, storage, server, boot };
}

/** A stats window big enough that two of them overfill the half of the queue that non-P0 records may use. */
export const bigStats = (windowMs = 10_000): { readonly type: "call_stats"; readonly stats: NonNullable<TelemetryEvent["stats"]> } => ({
  type: "call_stats",
  stats: { window_ms: windowMs, connection_type: "udp", tracks: Array.from({ length: 1200 }, (_, index) => ({ mid: String(index), kind: "audio", packets: 1, lost: 0, audio_energy: 0, playout: "playing" })) },
});
