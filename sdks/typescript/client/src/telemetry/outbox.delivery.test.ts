import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bigStats, createWorld, ended, expectConservation, failed, keyOf, seconds, type World } from "./outbox.delivery.test.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Writes the trace for the validator (`tools/formal/telemetry-delivery/run.sh --trace`) when `TELEMETRY_TRACE_DIR` is set. */
function writeTrace(world: World) {
  const dir = process.env.TELEMETRY_TRACE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${world.scenario}.ndjson`), `${world.steps.map((step) => JSON.stringify(step)).join("\n")}\n`);
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
    expect(world.steps.map((step) => step.a)).toEqual(["record", "send", "receive", "commit", "write", "respond", "lose_answer", "timeout", "send", "receive", "commit", "write", "respond", "ack"]);
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

  it("stores nothing when the server crashes before the commit, and the retry writes the row once", async () => {
    const world = createWorld("crash-before-commit");
    const client = world.boot();
    world.server.faults.push("crash");
    client.outbox.record(ended);
    await seconds(10);
    expect(world.server.requests).toHaveLength(2);
    expect(world.server.rows).toHaveLength(1);
    expect([...world.server.ledger(client.outbox.sourceId).stored]).toEqual([0]);
    expect(world.steps.map((step) => step.a)).toEqual(["record", "send", "receive", "server_crash", "timeout", "send", "receive", "commit", "write", "respond", "ack"]);
    expectConservation(world);
    writeTrace(world);
  });

  it("loses the row when the server crashes between the commit and the sink write: the retry is a duplicate, and the reader sees a stored seq with no row", async () => {
    const world = createWorld("crash-after-commit");
    const client = world.boot();
    world.server.faults.push("crash_after_commit");
    client.outbox.record(ended);
    await seconds(10);
    const source = client.outbox.sourceId;
    const ledger = world.server.ledger(source);
    expect(world.server.requests).toHaveLength(2);
    expect(world.server.rows).toHaveLength(0);
    expect([...ledger.stored]).toEqual([0]);
    expect([...ledger.stored].filter((seq) => !world.server.stored().has(keyOf(source, seq)))).toEqual([0]);
    expect(world.steps.filter((step) => step.a === "ack")).toEqual([{ a: "ack", src: source, batch: expect.any(String), acks: [0] }]);
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
    const source = client.outbox.sourceId;
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
    const source = client.outbox.sourceId;
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
  it("leaves the drop list of an abandoned predecessor unsent, because its saved high-water mark is only a lower bound, and reports the source abandoned there", async () => {
    const world = createWorld("reload-leaves-drops-unsent");
    const first = world.boot();
    const before = first.outbox.sourceId;
    first.state.online = false;
    first.outbox.record(ended);
    first.outbox.record(bigStats());
    first.outbox.record(bigStats());
    first.crash();
    const second = world.boot();
    const after = second.outbox.sourceId;
    await seconds(5);
    expect(world.server.ledger(before)).toMatchObject({ end: "abandoned", endNext: 1, stored: new Set([0]), dropped: new Set() });
    expect([...world.server.stored().keys()].filter((key) => key.startsWith(`${after}/`))).toEqual([]);
    const actions = world.steps.map((step) => step.a);
    expect(actions.slice(0, 6)).toEqual(["record", "record", "record", "evict", "crash", "reboot"]);
    expect(actions).not.toContain("emit_drop");
    expect(world.storage.length).toBe(0);
    expectConservation(world);
    writeTrace(world);
  });

  it("reports a predecessor abandoned at its last checkpoint, and sends the P0 records it still held", async () => {
    const world = createWorld("reload-abandoned");
    const first = world.boot();
    const before = first.outbox.sourceId;
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
    const before = first.outbox.sourceId;
    first.state.online = false;
    first.outbox.record(ended);
    first.outbox.record(failed);
    first.pagehide();
    first.gone();
    const second = world.boot();
    await seconds(5);
    expect(world.server.ledger(before)).toMatchObject({ end: "closed", endNext: 2, stored: new Set([0, 1]) });
    expect(world.steps.map((step) => step.a)).toEqual(["record", "record", "pagehide", "reboot", "send", "receive", "commit", "write", "respond", "ack"]);
    expect(second.outbox.sourceId).not.toBe(before);
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
    const source = first.outbox.sourceId;
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
    const before = first.outbox.sourceId;
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
