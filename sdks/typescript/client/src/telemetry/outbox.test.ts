import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestOutbox, expectUnbrokenSequence, statsEvent } from "./outbox.test.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const credential = (subject = "tenant/episode/participant", token = "token", tenantId = "tenant") => ({ tenantId, subject, token, expiresAt: Date.now() + 300_000 });
const seconds = (count: number) => vi.advanceTimersByTimeAsync(count * 1000);

describe("recording", () => {
  it("numbers events from 0 in one session and stamps the monotonic time since the session began", async () => {
    let now = 5000;
    const test = createTestOutbox({ now: () => now });
    test.outbox.record({ type: "space_join_span", outcome: "started" });
    now += 250;
    test.outbox.record({ type: "platform_changed", platform_state: "visible" });
    await test.outbox.flush();
    expect(test.accepted.map(({ seq, elapsed_ms }) => ({ seq, elapsed_ms }))).toEqual([
      { seq: 0, elapsed_ms: 0 },
      { seq: 1, elapsed_ms: 250 },
    ]);
    expect(JSON.parse(test.requests[0]?.send.body ?? "{}")).toMatchObject({ version: 1, client_session_id: test.outbox.sessionId });
  });

  it("sends started events at once, routine events within 2 seconds and stats windows within 30", async () => {
    const test = createTestOutbox();
    test.outbox.record({ type: "space_join_span", outcome: "started" });
    await seconds(0);
    expect(test.accepted.map((event) => event.type)).toEqual(["space_join_span"]);
    test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    await seconds(1);
    expect(test.accepted).toHaveLength(1);
    await seconds(1);
    expect(test.accepted).toHaveLength(2);
    test.outbox.record(statsEvent());
    await seconds(29);
    expect(test.accepted).toHaveLength(2);
    await seconds(1);
    expect(test.accepted).toHaveLength(3);
    expectUnbrokenSequence(test.accepted);
  });

  it("keeps a full queue bounded: it folds the oldest stats windows into one gap window and counts what it drops", async () => {
    const test = createTestOutbox();
    test.emit("offline");
    const track = { mid: "0", kind: "audio", packets: 1, lost: 0, audio_energy: 0, playout: "playing" } as const;
    for (let window = 0; window < 400; window++) test.outbox.record({ type: "call_stats", stats: { window_ms: 10_000, connection_type: "udp", tracks: Array.from({ length: 32 }, () => track) } });
    for (let event = 0; event < 400; event++) test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    test.emit("online");
    await test.outbox.flush();
    await test.outbox.flush();
    const folded = test.accepted.filter((event) => event.type === "call_stats" && event.stats?.gap === "dropped");
    expect(folded.length).toBeGreaterThan(0);
    expect(test.accepted.some((event) => event.type === "telemetry_dropped")).toBe(true);
    expectUnbrokenSequence(test.accepted);
  });

  it("never throws, even after dispose", async () => {
    const test = createTestOutbox();
    await test.outbox.dispose();
    expect(() => test.outbox.record({ type: "platform_changed", platform_state: "visible" })).not.toThrow();
    expect(test.requests).toHaveLength(0);
  });
});

describe("faults", () => {
  it("holds events while offline and sends them in order when the network returns", async () => {
    const test = createTestOutbox();
    test.emit("offline");
    test.outbox.record({ type: "recovery_attempt", mechanism: "media_reconnect" });
    test.outbox.record(statsEvent(70_000));
    await seconds(120);
    expect(test.requests).toHaveLength(0);
    test.emit("online");
    await seconds(0);
    expect(test.accepted.map((event) => event.type)).toEqual(["platform_changed", "recovery_attempt", "call_stats", "platform_changed"]);
    expectUnbrokenSequence(test.accepted);
  });

  it("waits out Retry-After on 429, then sends the same events once", async () => {
    const test = createTestOutbox();
    test.answer({ status: 429, retryAfterMs: 20_000 });
    test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    await seconds(2);
    expect(test.requests).toHaveLength(1);
    await seconds(18);
    expect(test.requests).toHaveLength(1);
    await seconds(2);
    expect(test.requests).toHaveLength(2);
    expect(test.accepted.map((event) => event.seq)).toEqual([0]);
    expectUnbrokenSequence(test.accepted);
  });

  it("backs off with jitter on 5xx and network errors, and loses nothing", async () => {
    const test = createTestOutbox({ random: () => 0.5 });
    test.answer({ status: 503, retryAfterMs: 0 }, "network_error", { status: 500, retryAfterMs: 0 });
    test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    await seconds(2);
    expect(test.requests).toHaveLength(1);
    await seconds(1);
    expect(test.requests).toHaveLength(2);
    await seconds(1);
    expect(test.requests).toHaveLength(2);
    await seconds(60);
    expect(test.requests).toHaveLength(4);
    expect(test.accepted.map((event) => event.seq)).toEqual([0]);
  });

  it("refreshes an expired credential once and retries the same batch", async () => {
    const test = createTestOutbox();
    const refresh = vi.fn(async () => undefined);
    test.outbox.bind({ current: () => credential(), refresh });
    test.answer({ status: 401, retryAfterMs: 0 });
    test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    await seconds(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(test.accepted.map((event) => event.seq)).toEqual([0]);
  });

  it("refreshes once for a credential the server keeps rejecting, then backs off and keeps the events", async () => {
    const test = createTestOutbox({ random: () => 0.5 });
    const refresh = vi.fn(async () => undefined);
    test.outbox.bind({ current: () => credential(), refresh });
    test.answer(...Array.from({ length: 4 }, () => ({ status: 401, retryAfterMs: 0 })));
    test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    await seconds(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(test.requests).toHaveLength(2);
    await seconds(60);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(test.requests).toHaveLength(5);
    expect(test.accepted.map((event) => event.seq)).toEqual([0]);
    expectUnbrokenSequence(test.accepted);
  });

  it("answers a rejected batch with no request of its own, and counts the loss in the next batch that real events make", async () => {
    const test = createTestOutbox();
    test.answer({ status: 400, retryAfterMs: 0 });
    test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    await seconds(120);
    expect(test.requests).toHaveLength(1);
    expect(test.accepted).toHaveLength(0);
    test.outbox.record({ type: "connection_failed", code: "media_failed" });
    await seconds(2);
    expect(test.requests).toHaveLength(2);
    expect(test.accepted.map((event) => [event.seq, event.type, event.dropped ?? event.code])).toEqual([
      [1, "connection_failed", "media_failed"],
      [2, "telemetry_dropped", 1],
    ]);
    expectUnbrokenSequence(test.accepted);
  });

  it("keeps the count of a rejected batch that carried a count", async () => {
    const test = createTestOutbox();
    test.answer({ status: 400, retryAfterMs: 0 }, { status: 400, retryAfterMs: 0 });
    test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    await seconds(2);
    test.outbox.record({ type: "connection_failed", code: "media_failed" });
    await seconds(2);
    test.outbox.record({ type: "connection_failed", code: "media_failed" });
    await seconds(2);
    expect(test.accepted.map((event) => [event.type, event.dropped])).toEqual([
      ["connection_failed", undefined],
      ["telemetry_dropped", 3],
    ]);
    expectUnbrokenSequence(test.accepted);
  });

  it("holds events while the credential is expired and sends them when a fresh one arrives", async () => {
    const test = createTestOutbox({ bound: false });
    test.outbox.bind({ current: () => ({ tenantId: "tenant", subject: "tenant/episode/participant", token: "old", expiresAt: Date.now() - 1 }), refresh: async () => undefined });
    test.outbox.record({ type: "connection_failed", code: "media_start_failed" });
    await seconds(10);
    expect(test.requests).toHaveLength(0);
    test.outbox.bind({ current: () => credential(), refresh: async () => undefined });
    await seconds(0);
    expect(test.accepted).toHaveLength(1);
  });

  it("flushes on leave with keepalive, using the credential of the call that ended", async () => {
    const test = createTestOutbox();
    let grant: ReturnType<typeof credential> | null = credential();
    test.outbox.bind({ current: () => grant, refresh: async () => undefined });
    test.outbox.record({ type: "call_ended", end_reason: "left" });
    grant = null;
    await test.outbox.dispose();
    expect(test.requests.map((request) => request.send.keepalive)).toEqual([true]);
    expect(test.requests[0]?.send.token).toBe("token");
    expect(test.accepted.map((event) => event.end_reason)).toEqual(["left"]);
  });

  it("reports a page reload as page_closed and sends it with keepalive before the page goes", async () => {
    const test = createTestOutbox();
    test.outbox.onClosing(() => test.outbox.record({ type: "call_ended", end_reason: "page_closed" }));
    test.emit("closing");
    await seconds(0);
    expect(test.requests.at(-1)?.send.keepalive).toBe(true);
    expect(test.accepted.map((event) => event.end_reason)).toEqual(["page_closed"]);
  });

  it("sends an abandoned join as started and cancelled, in order", async () => {
    const test = createTestOutbox();
    test.outbox.record({ type: "space_join_span", outcome: "started" });
    await seconds(0);
    test.outbox.record({ type: "space_join_span", outcome: "cancelled" });
    await test.outbox.dispose();
    expect(test.accepted.map((event) => event.outcome)).toEqual(["started", "cancelled"]);
    expectUnbrokenSequence(test.accepted);
  });

  it("sends a native background at once and the return to the foreground after it", async () => {
    const test = createTestOutbox();
    test.emit("background");
    await seconds(0);
    expect(test.accepted.map((event) => event.platform_state)).toEqual(["background"]);
    test.emit("foreground");
    await seconds(2);
    expect(test.accepted.map((event) => event.platform_state)).toEqual(["background", "foreground"]);
  });

  it("stays unbroken and inside the 4 MiB budget for a 135 minute call", async () => {
    const test = createTestOutbox();
    test.outbox.bind({ current: () => credential(), refresh: async () => undefined });
    for (let window = 0; window < 135 * 6; window++) {
      test.outbox.record(statsEvent());
      await seconds(10);
    }
    await test.outbox.flush();
    expect(test.accepted).toHaveLength(135 * 6);
    expectUnbrokenSequence(test.accepted);
    expect(test.requests.reduce((bytes, request) => bytes + request.send.body.length, 0)).toBeLessThan(4 * 1024 * 1024);
  });
});
