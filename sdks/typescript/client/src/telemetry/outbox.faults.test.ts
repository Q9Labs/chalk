import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestOutbox, expectUnbrokenSequence } from "./outbox.test.helpers";
import { postTelemetry } from "./send";

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

  /** The retired source and the new one: the retired one is the source that sent `end`. */
  const sources = (test: ReturnType<typeof createTestOutbox>) => {
    const all = [...new Set(test.requests.map((request) => request.body.source_id))];
    const old = test.requests.find((request) => request.body.end)?.body.source_id ?? test.requests.find((request) => request.send.token === "token")?.body.source_id;
    return [old, all.find((source) => source !== old)];
  };
  const of = (test: ReturnType<typeof createTestOutbox>, source: string | undefined) => test.requests.filter((request) => request.body.source_id === source);

  it("retries the same V2 frame when an old API refuses its schema", async () => {
    const test = createTestOutbox();
    const legacyRefusal: typeof fetch = async () => Response.json(
      { error: { code: "request.invalid", message: "Invalid request body" } },
      { status: 400 },
    );
    test.answer(await postTelemetry(legacyRefusal, {
      url: "https://api.test/telemetry", token: "synthetic", traceparent: "",
      body: "{}", keepalive: true, signal: new AbortController().signal,
    }));
    test.outbox.record(failed);
    await test.outbox.flush();
    await seconds(2);
    expect(test.requests.map(({ status }) => status)).toEqual([400, 200]);
    expect(test.requests[1]?.send.body).toBe(test.requests[0]?.send.body);
    expect(test.accepted.map(({ seq }) => seq)).toEqual([0]);
    test.outbox.dispose();
  });

  it.each([
    { name: "another tenant", second: credential("tenant-b/episode/participant", "token-b", "tenant-b"), url: "tenant-b" },
    { name: "another Episode of the same tenant", second: credential("tenant/episode-2/participant", "token-2"), url: "tenant" },
  ])("starts a new source for $name, and closes the old one under its own credential at its exact next_seq", async ({ second, url }) => {
    const test = createTestOutbox();
    let grant = credential();
    test.outbox.bind({ current: () => grant, refresh: async () => undefined });
    test.outbox.record(failed);
    grant = second;
    test.outbox.record(failed);
    await test.outbox.flush();
    const [first, next] = sources(test);
    expect(first).not.toBe(next);
    const old = of(test, first);
    expect(old.map((request) => request.send.token)).toEqual(["token"]);
    expect(old.map((request) => [request.events.map((event) => event.seq), request.body.next_seq, request.body.end])).toEqual([[[0], 1, "closed"]]);
    const fresh = of(test, next);
    expect(fresh.map((request) => request.send.token)).toEqual([second.token]);
    expect(fresh[0]?.send.url).toContain(`/${url}/`);
    expect(fresh.map((request) => request.events.map((event) => event.seq))).toEqual([[0]]);
    for (const source of [first, next]) expectUnbrokenSequence(test.accepted.filter((event) => of(test, source).some((request) => request.events.includes(event))));
  });

  it("abandons the source of a credential that expired: nothing of it is sent, and the new join counts from 0", async () => {
    const steps: string[] = [];
    const test = createTestOutbox({ bound: false, trace: (step) => steps.push(step.a) });
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
    expect(bodyOf(test, 0)).toEqual([0]);
    expect(steps).toContain("rejoin");
    expect(steps).toContain("abandon");
    expectUnbrokenSequence(test.accepted);
  });

  it("does not refresh the credential of another call when an old call's batch is rejected, and abandons the old source", async () => {
    const steps: string[] = [];
    const test = createTestOutbox({ bound: false, trace: (step) => steps.push(step.a) });
    let refreshes = 0;
    const refresh = async () => {
      refreshes += 1;
    };
    let grant = credential();
    test.outbox.bind({ current: () => grant, refresh });
    test.outbox.record(failed);
    grant = credential("tenant/episode-2/participant", "token-2");
    test.answer({ status: 200, retryAfterMs: 0 }, { status: 401, retryAfterMs: 0 });
    test.outbox.record(failed);
    await test.outbox.flush();
    test.outbox.record(failed);
    await test.outbox.flush();
    expect(refreshes).toBe(0);
    const [first, next] = sources(test);
    expect(of(test, first).map((request) => [request.send.token, request.status])).toEqual([["token", 401]]);
    expect(of(test, next).map((request) => request.send.token)).toEqual(["token-2", "token-2"]);
    expect(test.accepted.map((event) => event.seq)).toEqual([0, 1]);
    expect(steps).toContain("abandon");
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
    expect([bodyOf(test, 1), bodyOf(test, 2)]).toEqual([[0], [1]]);
    expect(test.requests[1]?.body.batch_id).toBe(test.requests[0]?.body.batch_id);
    expectUnbrokenSequence(test.accepted);
  });

  it("holds a page_closed event while an earlier request is in flight, because one batch per source is in flight, and the journal keeps it", async () => {
    const test = createTestOutbox();
    test.outbox.onClosing(() => test.outbox.record({ type: "call_ended", end_reason: "page_closed" }));
    const release = test.hold();
    test.outbox.record(failed);
    await seconds(2);
    expect(test.requests).toHaveLength(1);
    test.emit("closing");
    expect(test.requests).toHaveLength(1);
    release();
    await seconds(0);
    expect(test.requests.map((request) => request.send.keepalive)).toEqual([true, true]);
    expect(bodyOf(test, 1)).toEqual([1]);
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
