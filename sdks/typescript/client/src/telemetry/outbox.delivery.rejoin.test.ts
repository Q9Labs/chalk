/** The delivery model's journeys across a new join, disposal and a failing journal. The exactly-once, full-queue and reload journeys are in outbox.delivery.test.ts. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bigStats, createWorld, ended, expectConservation, keyOf, MemoryStorage, seconds, type World } from "./outbox.delivery.test.helpers";
import { createSessionJournal } from "./web-platform";
import { createTestOutbox, statsEvent } from "./outbox.test.helpers";

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

describe("a new join", () => {
  const grant = (participant: string, expiresInMs = 3_600_000) => ({ tenantId: "tenant", subject: `tenant/episode/${participant}`, token: `token-${participant}`, expiresAt: Date.now() + expiresInMs });
  const tokensOf = (world: World, source: string) => world.server.requests.flatMap((request, index) => (request.source_id === source ? [world.server.tokens[index]] : []));

  it("starts a new source at seq 0 and closes the old one at its exact next_seq, each under its own credential", async () => {
    const world = createWorld("rejoin");
    const client = world.boot({ bind: false });
    let current = grant("guest-1");
    client.outbox.bind({ current: () => current, refresh: async () => undefined });
    client.outbox.record(ended);
    await seconds(3);
    const before = client.outbox.sourceId;
    current = grant("guest-2");
    client.outbox.record(ended);
    await seconds(3);
    const after = world.server.requests.find((request) => request.source_id !== before)?.source_id ?? "";
    expect(after).not.toBe(before);
    expect(world.server.stored().get(keyOf(after, 0))?.type).toBe("call_ended");
    expect(world.server.ledger(before)).toMatchObject({ owner: "token-guest-1", end: "closed", endNext: 1, endRejection: "" });
    expect(world.server.ledger(after)).toMatchObject({ owner: "token-guest-2", end: "" });
    expect(tokensOf(world, before)).toEqual(["token-guest-1", "token-guest-1"]);
    expect(world.steps.filter((step) => step.a === "rejoin")).toEqual([{ a: "rejoin", src: before, next: after }]);
    expectConservation(world);
    writeTrace(world);
  });

  it("names the old source's drop list in a record of that source when it closes, and sends it under the old credential", async () => {
    const world = createWorld("rejoin-names-drops");
    const client = world.boot({ bind: false });
    let current = grant("guest-1");
    client.outbox.bind({ current: () => current, refresh: async () => undefined });
    const before = client.outbox.sourceId;
    client.state.online = false;
    client.outbox.record(ended);
    client.outbox.record(bigStats());
    client.outbox.record(bigStats());
    current = grant("guest-2");
    client.state.online = true;
    client.outbox.record(ended);
    await seconds(5);
    const drop = [...world.server.stored()].find(([, event]) => event.type === "telemetry_dropped");
    expect(drop?.[0].startsWith(`${before}/`)).toBe(true);
    expect(drop?.[1]).toMatchObject({ dropped: 1, dropped_seqs: [{ from: 1, to: 2 }], drop_reason: "queue_full" });
    expect(world.server.ledger(before)).toMatchObject({ end: "closed", endNext: 4, dropped: new Set([1]), endRejection: "" });
    expect(new Set(tokensOf(world, before))).toEqual(new Set(["token-guest-1"]));
    expectConservation(world);
    writeTrace(world);
  });

  it("sends a predecessor's records and end under the predecessor's own credential when the reload is another participant", async () => {
    const world = createWorld("reload-as-another-participant");
    const first = world.boot({ bind: false });
    first.outbox.bind({ current: () => grant("guest-1"), refresh: async () => undefined });
    const before = first.outbox.sourceId;
    first.state.online = false;
    first.outbox.record(ended);
    first.crash();
    const second = world.boot({ bind: false });
    second.outbox.bind({ current: () => grant("guest-2"), refresh: async () => undefined });
    await seconds(5);
    expect(world.server.ledger(before)).toMatchObject({ owner: "token-guest-1", end: "abandoned", endNext: 1, stored: new Set([0]) });
    expect(new Set(tokensOf(world, before))).toEqual(new Set(["token-guest-1"]));
    expectConservation(world);
    writeTrace(world);
  });

  it("saves the high-water mark before a batch leaves, so the abandoned end a reload reports is never below a next_seq the server saw", async () => {
    const world = createWorld("reload-after-unsaved-send");
    const first = world.boot();
    const before = first.outbox.sourceId;
    first.outbox.record(ended);
    await first.outbox.flush();
    first.outbox.record(statsEvent());
    first.outbox.record(statsEvent());
    await first.outbox.flush();
    first.crash();
    world.boot();
    await seconds(5);
    expect(world.server.ledger(before)).toMatchObject({ reported: 3, end: "abandoned", endNext: 3, endRejection: "" });
    expectConservation(world);
    writeTrace(world);
  });

  it("abandons a predecessor whose credential expired: nothing of it is sent, its gap stays open, and its journal is removed", async () => {
    const world = createWorld("reload-expired-credential");
    const first = world.boot({ bind: false });
    first.outbox.bind({ current: () => grant("guest-1", 5000), refresh: async () => undefined });
    const before = first.outbox.sourceId;
    first.state.online = false;
    first.outbox.record(ended);
    first.crash();
    await seconds(10);
    const second = world.boot({ bind: false });
    second.outbox.bind({ current: () => grant("guest-2"), refresh: async () => undefined });
    await seconds(5);
    expect(world.server.requests.filter((request) => request.source_id === before)).toEqual([]);
    expect(world.steps).toContainEqual({ a: "abandon", src: before });
    expect(world.storage.getItem(`chalk.telemetry.${before}`)).toBeNull();
  });
});

describe("disposal", () => {
  it("names the drop list first, then closes the source with its exact next_seq, and the journal goes", async () => {
    const world = createWorld("dispose-closed");
    const client = world.boot();
    const source = client.outbox.sourceId;
    client.outbox.record(ended);
    client.outbox.record(bigStats());
    client.outbox.record(bigStats());
    await client.outbox.dispose();
    expect(world.server.ledger(source)).toMatchObject({ end: "closed", endNext: 4, stored: new Set([0, 2, 3]), dropped: new Set([1]) });
    expect(world.server.requests.at(-1)).toMatchObject({ events: [], end: "closed", next_seq: 4 });
    expect(world.steps.map((step) => step.a)).toEqual(["record", "record", "record", "evict", "emit_drop", "send", "receive", "commit", "write", "respond", "ack", "dispose", "send", "receive", "commit", "respond", "ack"]);
    expect(world.storage.length).toBe(0);
    expectConservation(world);
    writeTrace(world);
  });

  it("names the whole drop list while offline, even past an unsettled drop record, and the next boot delivers it", async () => {
    const world = createWorld("dispose-offline");
    const first = world.boot();
    const before = first.outbox.sourceId;
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
    expect(storage.key(0)).toBe(`chalk.telemetry.${test.outbox.sourceId}`);
  });
});
