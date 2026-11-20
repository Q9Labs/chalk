// fallow-ignore-file complexity -- every branch is a delivery step; the outbox delivery tests and the formal trace replay cover each one, which the CRAP estimate cannot see.
import { expect, vi } from "vitest";
import { TelemetryOutbox } from "./outbox";
import type { DeliveryStep, PlatformChange, SeqRange, TelemetryEvent, TelemetryPlatform, TelemetryRequest, TelemetrySendResult } from "./types";
import { createSessionJournal } from "./web-platform";

/** What the trace holds: the outbox's own steps, plus what the test harness and the protocol double did. */
export type TraceStep =
  | DeliveryStep
  | { readonly a: "crash" }
  | { readonly a: "receive"; readonly batch: string; readonly settle: readonly number[] }
  | { readonly a: "refuse"; readonly batch: string }
  | { readonly a: "commit" }
  | { readonly a: "write" }
  | { readonly a: "respond" }
  | { readonly a: "server_crash" }
  | { readonly a: "lose_request"; readonly batch: string }
  | { readonly a: "lose_answer"; readonly batch: string };

/** What goes wrong with the next request that reaches the double. `crash` dies before the commit, `crash_after_commit` between the commit and the sink write. `settle` settles only those seqs of the batch. */
export type Fault = "lose_request" | "lose_answer" | "crash" | "crash_after_commit" | "unavailable" | { readonly settle: readonly number[] };

/** One source row. `owner` is the token of its first batch: the double treats a token as the participant it speaks for. */
type SourceLedger = { owner: string; readonly stored: Set<number>; readonly dropped: Set<number>; reported: number; end: "" | "closed" | "abandoned"; endNext: number; endRejection: string };
type EvidenceRow = { readonly source: string; readonly event: TelemetryEvent };

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

/**
 * The server rules of docs/telemetry-delivery.md: the ledger and the pending
 * rows share a commit. A reply names settled seqs without waiting for export.
 */
export class ProtocolDouble {
  readonly ledgers = new Map<string, SourceLedger>();
  readonly rows: EvidenceRow[] = [];
  readonly requests: TelemetryRequest[] = [];
  /** The token of each request, in the order of `requests`. */
  readonly tokens: string[] = [];
  readonly faults: Fault[] = [];
  autoRelay = true;
  readonly #pending: EvidenceRow[] = [];
  readonly #emit: (step: TraceStep) => void;

  constructor(emit: (step: TraceStep) => void) {
    this.#emit = emit;
  }

  ledger(source: string): SourceLedger {
    let found = this.ledgers.get(source);
    if (!found) {
      found = { owner: "", stored: new Set(), dropped: new Set(), reported: 0, end: "", endNext: 0, endRejection: "" };
      this.ledgers.set(source, found);
    }
    return found;
  }

  /** The records as the reader sees them: copies of one `(source_id, seq)` collapse to one. */
  stored(): Map<string, TelemetryEvent> {
    return new Map(this.rows.map((row) => [`${row.source}/${row.event.seq}`, row.event]));
  }

  relay(): void {
    if (this.#pending.length === 0) return;
    this.rows.push(...this.#pending.splice(0));
    this.#emit({ a: "write" });
  }

  handle(body: TelemetryRequest, signal: AbortSignal, token: string): Promise<TelemetrySendResult> {
    this.requests.push(body);
    this.tokens.push(token);
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
    if (ledger.owner !== "" && ledger.owner !== token) {
      this.#emit({ a: "refuse", batch });
      return Promise.resolve({ status: 400, retryAfterMs: 0 });
    }
    if (fault === "crash") {
      this.#emit({ a: "server_crash" });
      return Promise.reject(new TypeError("the server died"));
    }
    const fresh = body.events.filter((event) => settle.includes(event.seq) && !ledger.stored.has(event.seq));
    ledger.owner = token;
    for (const event of fresh) {
      ledger.stored.add(event.seq);
      for (const range of event.dropped_seqs ?? []) for (let seq = range.from; seq < range.to; seq++) ledger.dropped.add(seq);
    }
    applyEnd(ledger, body);
    ledger.reported = Math.max(ledger.reported, body.next_seq ?? 0);
    this.#pending.push(...fresh.map((event) => ({ source, event })));
    this.#emit({ a: "commit" });
    if (fault === "crash_after_commit") {
      this.#emit({ a: "server_crash" });
      return Promise.reject(new TypeError("the server died"));
    }
    if (this.autoRelay) this.relay();
    this.#emit({ a: "respond" });
    if (fault === "lose_answer") {
      this.#emit({ a: "lose_answer", batch });
      return never(signal);
    }
    return Promise.resolve({ status: 200, retryAfterMs: 0, acks: settle.map((seq): SeqRange => ({ from: seq, to: seq + 1 })) });
  }
}

/** An end below the committed history (the highest stored seq + 1, or a `next_seq` already reported) is refused and the suffix stays a gap. A second close at another `next_seq` is refused too. */
function applyEnd(ledger: SourceLedger, body: TelemetryRequest): void {
  if (!body.end) return;
  const next = body.next_seq ?? 0;
  if (ledger.end === "closed") {
    if (next !== ledger.endNext) ledger.endRejection = "end_conflict";
    return;
  }
  const floor = Math.max(ledger.reported, ...[...ledger.stored].map((seq) => seq + 1));
  if (next < floor) {
    ledger.endRejection = "end_short";
    return;
  }
  ledger.end = body.end;
  ledger.endNext = next;
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
        return server.handle(body, request.signal, request.token);
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

export const seconds = (count: number) => vi.advanceTimersByTimeAsync(count * 1000);
export const ended = { type: "call_ended", end_reason: "left" } as const;
export const failed = { type: "connection_failed", code: "media_start_failed" } as const;
export type World = ReturnType<typeof createWorld>;

export const keyOf = (source: string, seq: number) => `${source}/${seq}`;

/** The rule the model checks, read off the double: every P0 record the client made is stored or named by a stored drop record, and every seq below a source's high-water mark is stored, named, or one of the records the test knows died in memory. */
export function expectConservation(world: World, lost: readonly string[] = []) {
  const stored = world.server.stored();
  const named = new Set<string>();
  for (const [key, event] of stored) {
    if (event.type !== "telemetry_dropped") continue;
    const source = key.split("/")[0] ?? "";
    for (const range of event.dropped_seqs ?? []) for (let seq = range.from; seq < range.to; seq++) named.add(keyOf(source, seq));
  }
  const p0 = world.steps.flatMap((step: TraceStep) => (step.a === "record" && step.p0 ? [keyOf(step.src, step.seq)] : step.a === "emit_drop" ? [keyOf(step.src, step.seq)] : []));
  for (const key of p0) expect(stored.has(key) || named.has(key), `P0 record ${key} is neither stored nor named`).toBe(true);
  for (const [source, ledger] of world.server.ledgers) {
    const high = ledger.end === "closed" ? ledger.endNext : Math.max(ledger.reported, ledger.endNext);
    for (let seq = 0; seq < high; seq++) expect(ledger.stored.has(seq) || ledger.dropped.has(seq) || lost.includes(keyOf(source, seq)), `seq ${keyOf(source, seq)} is unaccounted`).toBe(true);
  }
}
