import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestOutbox, expectUnbrokenSequence } from "./outbox.test.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const credential = (subject = "tenant/episode/participant", token = "token", tenantId = "tenant") => ({ tenantId, subject, token, expiresAt: Date.now() + 300_000 });
const seconds = (count: number) => vi.advanceTimersByTimeAsync(count * 1000);

describe("faults at the boundaries of a credential and of a request", () => {
  const failed = { type: "connection_failed", code: "media_start_failed" } as const;
  const bodyOf = (test: ReturnType<typeof createTestOutbox>, index: number) => test.requests[index]?.events.map((event) => event.seq);

  it.each([
    { name: "another tenant", second: credential("tenant-b/episode/participant", "token-b", "tenant-b"), url: "tenant-b" },
    { name: "another Episode of the same tenant", second: credential("tenant/episode-2/participant", "token-2"), url: "tenant" },
  ])("sends each event under the credential of the call it came from: $name", async ({ second, url }) => {
    const test = createTestOutbox();
    let grant = credential();
    test.outbox.bind({ current: () => grant, refresh: async () => undefined });
    test.outbox.record(failed);
    grant = second;
    test.outbox.record(failed);
    await test.outbox.flush();
    expect(test.requests.map((request) => request.send.token)).toEqual(["token", second.token]);
    expect(test.requests[1]?.send.url).toContain(`/${url}/`);
    expect([bodyOf(test, 0), bodyOf(test, 1)]).toEqual([[0], [1]]);
    expectUnbrokenSequence(test.accepted);
  });

  it("drops the events of a credential that expired, and the next batch of real events counts them", async () => {
    const test = createTestOutbox({ bound: false });
    let grant = { ...credential(), expiresAt: Date.now() + 5000 };
    test.outbox.bind({ current: () => grant, refresh: async () => undefined });
    test.state.online = false;
    test.outbox.record(failed);
    await seconds(10);
    grant = credential("tenant/episode-2/participant", "token-2");
    test.state.online = true;
    test.outbox.record(failed);
    await test.outbox.flush();
    expect(test.requests.map((request) => request.send.token)).toEqual(["token-2"]);
    expect(bodyOf(test, 0)).toEqual([1]);
    test.outbox.record(failed);
    await test.outbox.flush();
    expect(test.accepted.map((event) => [event.seq, event.type, event.dropped])).toEqual([
      [1, "connection_failed", undefined],
      [2, "connection_failed", undefined],
      [3, "telemetry_dropped", 1],
    ]);
    expectUnbrokenSequence(test.accepted);
  });

  it("does not refresh the credential of another call when an old call's events are rejected, and counts them lost", async () => {
    const test = createTestOutbox({ bound: false });
    let refreshes = 0;
    const refresh = async () => {
      refreshes += 1;
    };
    let grant = credential();
    test.outbox.bind({ current: () => grant, refresh });
    test.outbox.record(failed);
    grant = credential("tenant/episode-2/participant", "token-2");
    test.answer({ status: 401, retryAfterMs: 0 });
    test.outbox.record(failed);
    await test.outbox.flush();
    test.outbox.record(failed);
    await test.outbox.flush();
    expect(refreshes).toBe(0);
    expect(test.requests.map((request) => request.send.token)).toEqual(["token", "token-2", "token-2"]);
    expect(test.accepted.map((event) => [event.seq, event.dropped])).toEqual([
      [1, undefined],
      [2, 1],
      [3, undefined],
    ]);
    expectUnbrokenSequence(test.accepted);
  });

  it("lets a later call refresh its credential after an earlier call's refresh did not help", async () => {
    const test = createTestOutbox({ bound: false, random: () => 0.5 });
    const refreshed: string[] = [];
    let grant = credential();
    test.outbox.bind({ current: () => grant, refresh: async () => void refreshed.push(grant.subject) });
    test.answer(...Array.from({ length: 2 }, () => ({ status: 401, retryAfterMs: 0 })));
    test.outbox.record(failed);
    await seconds(2);
    expect(refreshed).toEqual(["tenant/episode/participant"]);
    grant = credential("tenant/episode-2/participant", "token-2");
    test.answer({ status: 401, retryAfterMs: 0 }, { status: 401, retryAfterMs: 0 });
    test.outbox.record(failed);
    await seconds(60);
    expect(refreshed).toEqual(["tenant/episode/participant", "tenant/episode-2/participant"]);
  });

  it("keeps the wake-up of a backoff when a new event comes in", async () => {
    const test = createTestOutbox();
    test.answer({ status: 429, retryAfterMs: 20_000 });
    test.outbox.record(failed);
    await seconds(2);
    expect(test.requests).toHaveLength(1);
    test.outbox.record(failed);
    await seconds(17);
    expect(test.requests).toHaveLength(1);
    await seconds(3);
    expect(test.requests).toHaveLength(2);
    expect(bodyOf(test, 1)).toEqual([0, 1]);
    expectUnbrokenSequence(test.accepted);
  });

  it("sends a page_closed event while an earlier request is still in flight, and every request outlives the page", async () => {
    const test = createTestOutbox();
    test.outbox.onClosing(() => test.outbox.record({ type: "call_ended", end_reason: "page_closed" }));
    const release = test.hold();
    test.outbox.record(failed);
    await seconds(2);
    expect(test.requests).toHaveLength(1);
    test.emit("closing");
    expect(test.requests).toHaveLength(2);
    expect(test.requests.map((request) => request.send.keepalive)).toEqual([true, true]);
    expect(bodyOf(test, 1)).toEqual([1]);
    release();
    await seconds(0);
    expect(test.accepted.map((event) => event.seq).sort()).toEqual([0, 1]);
    expectUnbrokenSequence(test.accepted);
  });

  it.each(["background", "hidden"] as const)("sends what is queued the moment the app goes %s, before any timer", (change) => {
    const test = createTestOutbox();
    test.outbox.record(failed);
    test.emit(change);
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]?.send.keepalive).toBe(true);
    expect(bodyOf(test, 0)).toEqual([0, 1]);
  });
});
