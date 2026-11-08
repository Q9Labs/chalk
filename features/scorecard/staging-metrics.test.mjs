import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readNodeMetrics } from "./staging-metrics.mjs";
import { contention } from "./contention.mjs";
import { parseScorecard, SCORECARD_SCHEMA } from "./schema.mjs";

const wire = JSON.parse(readFileSync(new URL("./fixtures/axiom-metrics-shape.json", import.meta.url), "utf8"));
const env = { CHALK_AXIOM_STAGING_METRICS_DATASET: "test-metrics", CHALK_AXIOM_METRICS_BASE_URL: `https://${wire.host}`, CHALK_AXIOM_METRICS_QUERY_TOKEN: "synthetic-test-token" };
const own = { episode_id: "own-episode", session_id: "own-session" };
const input = { lease: { acquired: true, lost: false }, before: [], after: [], window: [own], ownEpisodes: [own.episode_id] };

function response(metric, values, instance = "boot-a") {
  const series = { metric, tags: { "service.name": "chalk-sfu", "deployment.environment.name": "staging", "service.instance.id": instance, "service.version": "test", "otel.scope.name": "test", "otel.scope.version": "test" }, start: 1767225600, resolution: 1, data: values, summary: 0 };
  assert.deepEqual(Object.keys(series).sort(), Object.keys(wire.response_shape.series.item).sort());
  return { metadata: { unit: "1" }, series: [series] };
}

function fake({ instance = "boot-a", sessions = 0, draining = 0, steal = 0.06 } = {}) {
  return async (url, options) => {
    assert.equal(new URL(url).host, wire.host);
    const request = JSON.parse(options.body);
    assert.deepEqual(Object.keys(request).sort(), Object.keys(wire.request).sort());
    const metric = request.mpl.match(/`test-metrics`:`([^`]+)`/)[1];
    assert.match(request.mpl, /`deployment.environment.name` == "staging"/);
    assert.match(request.mpl, /align using max/);
    const values = metric.endsWith("steal") ? [null, steal / 2, steal] : [metric.endsWith("sessions") ? sessions : draining];
    return { status: 200, json: async () => response(metric, values, instance) };
  };
}

async function read(fetchImpl = fake(), configuration = env) {
  return readNodeMetrics("2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z", { env: configuration, fetchImpl });
}

function card(isolation) {
  return parseScorecard({
    schema: SCORECARD_SCHEMA,
    run: { id: "metrics-test", commit: "a".repeat(40), tier: "nightly", environment: "staging", startedAt: "2026-01-01T00:00:00Z", client: { kind: "browser", browser: "test", region: "test", size: "test" } },
    mediaPlane: "chalk_sfu",
    metrics: [],
    dropped: [],
    contention: isolation,
  });
}

test("verified MPL shape supplies percent steal, incarnation and drain without publishing instance IDs", async () => {
  const boundary = await read();
  const window = await read(fake({ sessions: 3 }));
  const result = contention({ ...input, nodeBefore: boundary, nodeAfter: boundary, nodeWindow: window });
  assert.equal(result.contended, false);
  assert.deepEqual(result.steal_max, { value: 6, source: "axiom_metrics" });
  assert.deepEqual(result.incarnation_changes, { value: 0, source: "axiom_metrics" });
  assert.deepEqual(result.drain, { value: false, source: "axiom_metrics" });
  assert.equal(result.foreign_sessions_seen.value, 0); // The kit's in-window sessions are not foreign.
  assert.ok(!JSON.stringify(card(result)).includes("boot-a"));
  const changed = await read(fake({ instance: "boot-b", draining: 1, sessions: 1 }));
  const dirty = contention({ ...input, nodeBefore: boundary, nodeAfter: changed, nodeWindow: window });
  assert.equal(dirty.incarnation_changes.value, 1);
  assert.equal(dirty.drain.value, true);
  assert.equal(dirty.foreign_sessions_seen.value, 1);
  assert.equal(dirty.contended, true);
  assert.equal((await read(fake({ steal: 0 })))[0].host.stealPercent, 0);
});

test("empty, truncated, paginated, malformed and failed metrics never produce isolation", async () => {
  const metric = "chalk.sfu.host.cpu.steal";
  const ok = response(metric, [0.01]);
  for (const body of [{ series: [] }, response(metric, [null]), response(metric, Array(1000).fill(0.01)), { ...ok, continuationToken: "next" }, { ...ok, metadata: { unit: "1", truncated: true } }, { ...ok, series: Array(1000).fill(ok.series[0]) }, response(metric, ["0"]), response(metric, [1.5])]) {
    await assert.rejects(
      read(async () => ({ status: 200, json: async () => body })),
      /staging_metrics_query_/,
    );
  }
  for (const headers of [{ link: '<https://example.test/page>; rel="next"' }, { "x-axiom-truncated": "true" }, { "x-continuation-token": "next" }]) {
    await assert.rejects(
      read(async () => ({ status: 200, headers: new Headers(headers), json: async () => ok })),
      /incomplete/,
    );
  }
  for (const fetchImpl of [
    async () => ({ status: 503 }),
    async () => ({ status: 206 }),
    async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError("synthetic body");
      },
    }),
    async () => {
      throw new Error("synthetic network failure");
    },
  ]) {
    const unavailable = await read(fetchImpl).catch(() => []);
    const result = card(contention({ ...input, nodeBefore: unavailable, nodeAfter: unavailable, nodeWindow: unavailable })).contention;
    assert.equal(result.contended, true);
    for (const field of ["steal_max", "incarnation_changes", "drain"]) assert.equal(result[field].value, "unavailable");
  }
});

test("a missing token or missing phase cannot be mistaken for a known zero steal reading", async () => {
  await assert.rejects(read(fake(), { ...env, CHALK_AXIOM_METRICS_QUERY_TOKEN: "" }), /configuration_missing/);
  const boundary = await read();
  const missingSteal = boundary.map((row) => ({ ...row, host: {} }));
  const unknown = contention({ ...input, nodeBefore: boundary, nodeAfter: missingSteal, nodeWindow: boundary });
  assert.equal(unknown.steal_max.value, "unavailable");
  assert.equal(unknown.contended, true);
  for (const missing of ["nodeBefore", "nodeAfter", "nodeWindow"]) {
    const result = contention({ ...input, nodeBefore: boundary, nodeAfter: boundary, nodeWindow: boundary, [missing]: [] });
    assert.equal(result.contended, true);
    assert.equal(result.steal_max.value, "unavailable");
  }
});
