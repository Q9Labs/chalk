import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURES_BEFORE_PAGE, joinProbe, transition, type JoinResult, type ProbeState } from "./probe.ts";

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
