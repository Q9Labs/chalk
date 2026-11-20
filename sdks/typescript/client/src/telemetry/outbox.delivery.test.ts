import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bigStats, createWorld, MemoryStorage, type TraceStep } from "./outbox.delivery.test.helpers";
import { createSessionJournal } from "./web-platform";
import { createTestOutbox } from "./outbox.test.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const seconds = (count: number) => vi.advanceTimersByTimeAsync(count * 1000);
const ended = { type: "call_ended", end_reason: "left" } as const;
const failed = { type: "connection_failed", code: "media_start_failed" } as const;
type World = ReturnType<typeof createWorld>;

/** Writes the trace for the validator (`tools/formal/telemetry-delivery/run.sh --trace`) when `TELEMETRY_TRACE_DIR` is set. */
function writeTrace(world: World) {
  const dir = process.env.TELEMETRY_TRACE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${world.scenario}.ndjson`), `${world.steps.map((step) => JSON.stringify(step)).join("\n")}\n`);
}

const keyOf = (source: string, seq: number) => `${source}/${seq}`;

/** The rule the model checks, read off the double: every P0 record the client made is stored or named by a stored drop record, and every seq below a source's high-water mark is stored, named, or one of the records the test knows died in memory. */
function expectConservation(world: World, lost: readonly string[] = []) {
  const stored = world.server.stored();
  const named = new Set<string>();
  for (const [key, event] of stored) {
    if (event.type !== "telemetry_dropped") continue;
    const source = event.dropped_source_id ?? key.split("/")[0] ?? "";
    for (const range of event.dropped_seqs ?? []) for (let seq = range.from; seq < range.to; seq++) named.add(keyOf(source, seq));
  }
  const p0 = world.steps.flatMap((step: TraceStep) => (step.a === "record" && step.p0 ? [keyOf(step.src, step.seq)] : step.a === "emit_drop" ? [keyOf(step.src, step.seq)] : []));
  for (const key of p0) expect(stored.has(key) || named.has(key), `P0 record ${key} is neither stored nor named`).toBe(true);
  for (const [source, ledger] of world.server.ledgers) {
    const high = ledger.end === "closed" ? ledger.endNext : Math.max(ledger.reported, ledger.endNext);
    for (let seq = 0; seq < high; seq++) expect(ledger.stored.has(seq) || ledger.dropped.has(seq) || lost.includes(keyOf(source, seq)), `seq ${keyOf(source, seq)} is unaccounted`).toBe(true);
  }
}

describe("a record reaches the server exactly once", () => {
  it("resends a batch whose answer was lost with the same batch_id, and the server dedupes it", async () => {
    const world = createWorld("retry-lost-answer");
    const client = world.boot();
    world.server.faults.push("lose_answer");
    client.outbox.record(ended);
    await seconds(2);
    expect(world.server.requests).toHaveLength(1);
    await seconds(20);
    expect(world.server.requests).toHaveLength(2);
    expect(world.server.requests[1]).toEqual(world.server.requests[0]);
    expect(world.server.requests[0]?.batch_id).toBeTruthy();
    expect(world.server.rows).toHaveLength(1);
    expect(world.steps.map((step) => step.a)).toEqual(["record", "send", "receive", "write", "commit", "respond", "lose_answer", "timeout", "send", "receive", "write", "commit", "respond", "ack"]);
    expectConservation(world);
    writeTrace(world);
  });

  it("resends a lost request with the same batch_id", async () => {
    const world = createWorld("retry-lost-request");
    const client = world.boot();
    world.server.faults.push("lose_request");
    client.outbox.record(ended);
    await seconds(40);
    expect(world.server.requests.map((request) => request.batch_id)).toHaveLength(2);
    expect(world.server.requests[1]).toEqual(world.server.requests[0]);
    expect(world.server.stored().size).toBe(1);
    expectConservation(world);
    writeTrace(world);
  });

  it("answers 503 with the same batch again, and the answer is no settlement", async () => {
    const world = createWorld("retry-unavailable");
    const client = world.boot();
    world.server.faults.push("unavailable");
    client.outbox.record(ended);
    await seconds(10);
    expect(world.server.requests).toHaveLength(2);
    expect(world.server.requests[1]).toEqual(world.server.requests[0]);
    expect(world.steps.filter((step) => step.a === "timeout")).toHaveLength(1);
    expectConservation(world);
    writeTrace(world);
  });

  it("writes a row twice when the server crashes between the sink write and the commit, and the reader sees one", async () => {
    const world = createWorld("crash-between-write-and-commit");
    const client = world.boot();
    world.server.faults.push("crash");
    client.outbox.record(ended);
    await seconds(10);
    expect(world.server.rows).toHaveLength(2);
    expect(world.server.rows[0]?.event.event_id).toBe(world.server.rows[1]?.event.event_id);
    expect(world.server.stored().size).toBe(1);
    expect([...world.server.ledger(client.outbox.sessionId).stored]).toEqual([0]);
    expectConservation(world);
    writeTrace(world);
  });

  it("settles exactly the seqs the answer names and sends the rest in a new batch", async () => {
    const world = createWorld("partial-ack");
    const client = world.boot();
    world.server.faults.push({ settle: [0] });
    client.outbox.record(ended);
    client.outbox.record(failed);
    await seconds(10);
    expect(world.server.requests.map((request) => request.events.map((event) => event.seq))).toEqual([[0, 1], [1]]);
    expect(world.server.requests[1]?.batch_id).not.toBe(world.server.requests[0]?.batch_id);
    expect(world.server.stored().size).toBe(2);
    expectConservation(world);
    writeTrace(world);
  });

  it("keeps one batch per source in flight", async () => {
    const world = createWorld("one-in-flight");
    const client = world.boot();
    world.server.faults.push("lose_answer");
    client.outbox.record(ended);
    await seconds(2);
    client.outbox.record(failed);
    void client.outbox.flush();
    void client.outbox.flush();
    await seconds(5);
    expect(world.server.requests).toHaveLength(1);
    await seconds(20);
    expect(world.server.requests.map((request) => request.events.map((event) => event.seq))).toEqual([[0], [0], [1]]);
    expectConservation(world);
  });
});

describe("a full queue", () => {
  it("folds stats windows, keeps the newer, names the older in a drop record, and never gives up a P0 record", async () => {
    const world = createWorld("evict-fold");
    const client = world.boot();
    const source = client.outbox.sessionId;
    client.outbox.record(ended);
    client.outbox.record(bigStats());
    client.outbox.record(bigStats());
    await seconds(2);
    expect(world.steps.filter((step) => step.a === "evict")).toEqual([{ a: "evict", src: source, seq: 1 }]);
    const stored = world.server.stored();
    expect([...stored.keys()]).toEqual([keyOf(source, 0), keyOf(source, 2), keyOf(source, 3)]);
    expect(stored.get(keyOf(source, 2))?.stats).toEqual({ window_ms: 20_000, gap: "dropped" });
    expect(stored.get(keyOf(source, 3))).toMatchObject({ type: "telemetry_dropped", dropped: 1, dropped_seqs: [{ from: 1, to: 2 }], drop_reason: "queue_full" });
    expectConservation(world);
    writeTrace(world);
  });

  it("keeps every P0 record under a routine flood, and names every seq it gave up", async () => {
    const world = createWorld("flood");
    const client = world.boot();
    const source = client.outbox.sessionId;
    client.state.online = false;
    for (let round = 0; round < 40; round++) {
      client.outbox.record(round % 4 === 0 ? ended : bigStats());
      if (round % 2 === 0) client.outbox.record(failed);
    }
    client.state.online = true;
    await seconds(120);
    const stored = world.server.stored();
    const p0 = world.steps.flatMap((step) => (step.a === "record" && step.p0 ? [step.seq] : []));
    expect(p0.length).toBeGreaterThan(20);
    for (const seq of p0) expect(stored.has(keyOf(source, seq))).toBe(true);
    const evicted = world.steps.flatMap((step) => (step.a === "evict" ? [step.seq] : []));
    expect(evicted.length).toBeGreaterThan(20);
    for (const seq of evicted) expect(p0).not.toContain(seq);
    expectConservation(world);
    expect(world.server.ledger(source).dropped.size).toBe(evicted.length);
  });
});

describe("a reload", () => {
  it("takes over the drop list of a predecessor that died before it named it, and reports the source abandoned at the saved high-water mark", async () => {
    const world = createWorld("reload-takes-over-drops");
    const first = world.boot();
    const before = first.outbox.sessionId;
    first.state.online = false;
    first.outbox.record(ended);
    first.outbox.record(bigStats());
    first.outbox.record(bigStats());
    first.crash();
    const second = world.boot();
    const after = second.outbox.sessionId;
    await seconds(5);
    expect(world.server.ledger(before)).toMatchObject({ end: "abandoned", endNext: 1, stored: new Set([0]), dropped: new Set([1]) });
    expect(world.server.stored().get(keyOf(after, 0))).toMatchObject({ type: "telemetry_dropped", dropped: 1, dropped_source_id: before, dropped_seqs: [{ from: 1, to: 2 }], drop_reason: "queue_full" });
    const actions = world.steps.map((step) => step.a);
    expect(actions.slice(0, 7)).toEqual(["record", "record", "record", "evict", "crash", "reboot", "emit_drop"]);
    expect(actions.filter((action) => action === "ack")).toHaveLength(2);
    expect(world.storage.length).toBe(1);
    expectConservation(world);
    writeTrace(world);
  });

  it("reports a predecessor abandoned at its last checkpoint, and sends the P0 records it still held", async () => {
    const world = createWorld("reload-abandoned");
    const first = world.boot();
    const before = first.outbox.sessionId;
    first.state.online = false;
    first.outbox.record(ended);
    first.outbox.record(bigStats());
    first.outbox.record(bigStats());
    await seconds(2);
    first.outbox.record({ type: "platform_changed", platform_state: "visible" });
    await seconds(6);
    first.crash();
    world.boot();
    await seconds(5);
    expect(world.steps.filter((step) => step.a === "checkpoint")).toEqual([{ a: "checkpoint", src: before, next: 5 }]);
    expect(world.server.ledger(before)).toMatchObject({ end: "abandoned", endNext: 5, stored: new Set([0, 3]), dropped: new Set([1]) });
    expectConservation(world, [keyOf(before, 2), keyOf(before, 4)]);
    writeTrace(world);
  });

  it("reports a predecessor that saw pagehide as closed, with its exact next_seq", async () => {
    const world = createWorld("pagehide-closed");
    const first = world.boot();
    const before = first.outbox.sessionId;
    first.state.online = false;
    first.outbox.record(ended);
    first.outbox.record(failed);
    first.pagehide();
    first.gone();
    const second = world.boot();
    await seconds(5);
    expect(world.server.ledger(before)).toMatchObject({ end: "closed", endNext: 2, stored: new Set([0, 1]) });
    expect(world.steps.map((step) => step.a)).toEqual(["record", "record", "pagehide", "reboot", "send", "receive", "write", "commit", "respond", "ack"]);
    expect(second.outbox.sessionId).not.toBe(before);
    expectConservation(world);
    writeTrace(world);
  });

  it("does not take the journal of a client that is alive in this realm", async () => {
    const world = createWorld("live-in-realm");
    const live = new Set<string>();
    const first = world.boot({ liveSources: live });
    first.state.online = false;
    first.outbox.record(ended);
    world.boot({ liveSources: live });
    await seconds(5);
    expect(world.server.requests).toHaveLength(0);
    expect(world.steps.map((step) => step.a)).toEqual(["record"]);
    expect(world.storage.length).toBe(1);
  });

  it("does not take the source of a client that is still disposing", async () => {
    const world = createWorld("dispose-in-realm");
    const live = new Set<string>();
    const first = world.boot({ liveSources: live });
    const source = first.outbox.sessionId;
    first.outbox.record(ended);
    world.server.faults.push("lose_request");
    const disposing = first.outbox.dispose();
    await seconds(1);
    world.boot({ liveSources: live });
    await seconds(5);
    expect(world.server.requests.filter((request) => request.source_id === source)).toHaveLength(1);
    await seconds(60);
    await disposing;
    expect(live.has(source)).toBe(false);
  });

  it("clears the closing mark when a page restored from the back-forward cache records again", async () => {
    const world = createWorld("bfcache");
    const first = world.boot();
    const before = first.outbox.sessionId;
    first.state.online = false;
    first.outbox.record(ended);
    first.pagehide();
    first.outbox.record(failed);
    first.crash();
    world.boot();
    await seconds(5);
    expect(world.server.ledger(before).end).toBe("abandoned");
  });
});

describe("disposal", () => {
  it("names the drop list first, then closes the source with its exact next_seq, and the journal goes", async () => {
    const world = createWorld("dispose-closed");
    const client = world.boot();
    const source = client.outbox.sessionId;
    client.outbox.record(ended);
    client.outbox.record(bigStats());
    client.outbox.record(bigStats());
    await client.outbox.dispose();
    expect(world.server.ledger(source)).toMatchObject({ end: "closed", endNext: 4, stored: new Set([0, 2, 3]), dropped: new Set([1]) });
    expect(world.server.requests.at(-1)).toMatchObject({ events: [], end: "closed", next_seq: 4 });
    expect(world.steps.map((step) => step.a)).toEqual(["record", "record", "record", "evict", "emit_drop", "send", "receive", "write", "commit", "respond", "ack", "dispose", "send", "receive", "write", "commit", "respond", "ack"]);
    expect(world.storage.length).toBe(0);
    expectConservation(world);
    writeTrace(world);
  });

  it("names the whole drop list while offline, even past an unsettled drop record, and the next boot delivers it", async () => {
    const world = createWorld("dispose-offline");
    const first = world.boot();
    const before = first.outbox.sessionId;
    first.state.online = false;
    first.outbox.record(ended);
    first.outbox.record(bigStats());
    first.outbox.record(bigStats());
    await first.outbox.flush();
    first.outbox.record(bigStats());
    first.outbox.record(bigStats());
    await first.outbox.dispose();
    const actions = world.steps.map((step) => step.a);
    expect(actions.filter((action) => action === "emit_drop")).toHaveLength(2);
    expect(actions.at(-1)).toBe("dispose");
    first.crash();
    world.boot();
    await seconds(5);
    expect(world.server.ledger(before)).toMatchObject({ end: "closed", endNext: 7, stored: new Set([0, 3, 6]), dropped: new Set([1, 2]) });
    expect(world.storage.length).toBe(0);
    expectConservation(world, [keyOf(before, 4), keyOf(before, 5)]);
    writeTrace(world);
  });
});

describe("a journal that fails", () => {
  it("is no durability and never breaks the outbox", async () => {
    const full = createSessionJournal(() => ({
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => undefined,
    }));
    const blocked = createSessionJournal(() => {
      throw new DOMException("denied", "SecurityError");
    });
    for (const journal of [full, blocked]) {
      const test = createTestOutbox({ journal });
      test.outbox.record(ended);
      await test.outbox.flush();
      expect(test.accepted.map((event) => event.seq)).toEqual([0]);
      expect(test.outbox.durable).toBe(false);
    }
    expect(blocked.list()).toEqual([]);
  });

  it("is durable when it keeps what it was given", async () => {
    const storage = new MemoryStorage();
    const test = createTestOutbox({ journal: createSessionJournal(() => storage) });
    test.outbox.record(ended);
    expect(test.outbox.durable).toBe(true);
    expect(storage.key(0)).toBe(`chalk.telemetry.${test.outbox.sessionId}`);
  });
});
