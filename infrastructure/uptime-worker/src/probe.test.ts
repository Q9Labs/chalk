import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURES_BEFORE_PAGE, joinProbe, runJoinProbe, transition, type JoinResult, type ProbeState } from "./probe.ts";

const ok: JoinResult = { ok: true, ms: 120 };
const failed: JoinResult = { ok: false, stage: "sync handshake", detail: "no welcome within 10 s" };
const up = (failures = 0): ProbeState => ({ status: "up", failures });
const down: ProbeState = { status: "down", failures: 5 };

test("a healthy probe stays quiet", () => {
  assert.equal(transition(null, ok).message, undefined);
  assert.equal(transition(up(), ok).message, undefined);
});

test("one failure does not page, the second in a row does, once", () => {
  assert.equal(FAILURES_BEFORE_PAGE, 2);
  const first = transition(up(), failed);
  assert.equal(first.message, undefined);
  assert.deepEqual(first.next, { status: "up", failures: 1 });
  const second = transition(first.next, failed);
  assert.match(second.message ?? "", /sync handshake/);
  assert.equal(second.next.status, "down");
  assert.equal(transition(second.next, failed).message, undefined);
});

test("recovery sends one message and resets the count", () => {
  const recovered = transition(down, ok);
  assert.match(recovered.message ?? "", /recovered/);
  assert.deepEqual(recovered.next, up());
});

test("a failed run between two good ones leaves no page", () => {
  const blip = transition(up(), failed);
  assert.deepEqual(transition(blip.next, ok), { next: up() });
});

test("the join walks create, admit, handshake and always ends the episode", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url.pathname);
    if (url.pathname.endsWith("/episodes")) return Response.json({ id: "ep1" }, { status: 201 });
    if (url.pathname.endsWith("/participants")) return Response.json({ sync_token: "token" }, { status: 201 });
    if (url.pathname.endsWith("/end")) return Response.json({}, { status: 202 });
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  try {
    const result = await joinProbe({ PROBE_API_KEY: "k", PROBE_TENANT_ID: "t", PROBE_SPACE_ID: "s" }, new URL("https://api.example"), new URL("https://sync.example"));
    assert.deepEqual(result, { ok: false, stage: "sync handshake", detail: "no upgrade (HTTP 503)" });
    assert.deepEqual(calls, ["/v1/tenants/t/spaces/s/episodes", "/v1/tenants/t/spaces/s/episodes/ep1/participants", "/v1/sync", "/v1/tenants/t/spaces/s/episodes/ep1/end"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a rejected admission names its stage", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => (new URL(input.toString()).pathname.endsWith("/episodes") ? Response.json({ id: "ep1" }, { status: 201 }) : new Response(null, { status: 403 }))) as typeof fetch;
  try {
    const result = await joinProbe({ PROBE_API_KEY: "k", PROBE_TENANT_ID: "t", PROBE_SPACE_ID: "s" }, new URL("https://api.example"), new URL("https://sync.example"));
    assert.deepEqual(result, { ok: false, stage: "admit participant", detail: "HTTP 403" });
  } finally {
    globalThis.fetch = original;
  }
});

const api = new URL("https://api.example");
const sync = new URL("https://sync.example");

/** A KV that records when each write commits; `control.lateCommitMs` delays the next one. */
function fakeKv() {
  const store = new Map<string, string>();
  const writeTimes: number[] = [];
  const control = { lateCommitMs: 0 };
  const kv = {
    get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key) ?? "null") : null),
    put: async (key: string, value: string) => {
      const late = control.lateCommitMs;
      control.lateCommitMs = 0;
      await new Promise((resolve) => setTimeout(resolve, late));
      writeTimes.push(Date.now());
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, writeTimes, control, env: { PROBE_API_KEY: "k", PROBE_TENANT_ID: "t", PROBE_SPACE_ID: "s", PROBE_STATE: kv } };
}

/** Fetch for a join that succeeds or is refused at the first call. */
function fakeJoin(healthy: boolean): typeof fetch {
  const socket = {
    accept: () => undefined,
    close: () => undefined,
    send: () => undefined,
    addEventListener: (type: string, listener: (event: { data: string }) => void) => {
      if (type === "message") queueMicrotask(() => listener({ data: JSON.stringify({ type: "welcome" }) }));
    },
  };
  return (async (input: URL | RequestInfo) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (!healthy) return new Response(null, { status: 503 });
    if (path.endsWith("/episodes")) return Response.json({ id: "ep1" }, { status: 201 });
    if (path.endsWith("/participants")) return Response.json({ sync_token: "token" }, { status: 201 });
    if (path.endsWith("/end")) return Response.json({}, { status: 202 });
    return Object.assign(new Response(null), { webSocket: socket });
  }) as typeof fetch;
}

const failing = async () => {
  throw new Error("webhook down");
};

test("a page whose delivery fails is kept and delivered on the next cycle", async () => {
  const { env, writeTimes, control } = fakeKv();
  const original = globalThis.fetch;
  globalThis.fetch = fakeJoin(false);
  const sent: string[] = [];
  try {
    const cycle = (deliver: (message: string) => Promise<void>) => runJoinProbe(env, api, sync, deliver);
    await cycle(async (message) => void sent.push(message));
    assert.equal(sent.length, 0);
    await assert.rejects(cycle(failing), /webhook down/);
    control.lateCommitMs = 300;
    await cycle(async (message) => void sent.push(message));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /create episode/);
    // KV rejects a second write to the same key within a second, so the clear must wait.
    const [before = 0, last = 0] = writeTimes.slice(-2);
    assert.ok(last - before >= 990);
    await cycle(async (message) => void sent.push(message));
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("a recovery follows an outage page that was never delivered", async () => {
  const { env, store } = fakeKv();
  store.set("join-probe", JSON.stringify({ status: "down", failures: 4, pending: "outage page" }));
  const original = globalThis.fetch;
  globalThis.fetch = fakeJoin(true);
  const sent: string[] = [];
  try {
    await runJoinProbe(env, api, sync, async (message) => void sent.push(message));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^outage page\n\nChalk join probe recovered/);
    assert.deepEqual(JSON.parse(store.get("join-probe") ?? "null"), { status: "up", failures: 0 });
  } finally {
    globalThis.fetch = original;
  }
});

test("clearing a delivered page leaves a newer page that another cycle stored meanwhile", async () => {
  const { env, store } = fakeKv();
  const original = globalThis.fetch;
  globalThis.fetch = fakeJoin(false);
  try {
    await runJoinProbe(env, api, sync, async () => undefined);
    await runJoinProbe(env, api, sync, async () => {
      // A manual run stores its own page while this webhook call is still open.
      store.set("join-probe", JSON.stringify({ status: "down", failures: 3, pending: "newer page" }));
    });
    assert.equal(JSON.parse(store.get("join-probe") ?? "null").pending, "newer page");
  } finally {
    globalThis.fetch = original;
  }
});
