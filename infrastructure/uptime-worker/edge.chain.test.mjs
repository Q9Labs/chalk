// @ts-check
// Chain hop for edge.origin_unreachable, edge.asset_failures and the edge
// witnesses of release.failures_after_change: collectEdge reads a fake
// Cloudflare GraphQL API and runMonitorCycle posts its real uptime rows; the
// rows they post land in each symptom's chain dir, re-stamped to the chain's
// fixed times so the chain replays byte-identically. Run it:
//
//   node --test infrastructure/uptime-worker/edge.chain.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;
const { collectEdge } = await import(join(ROOT, "infrastructure/uptime-worker/src/edge.ts"));
const { runMonitorCycle } = await import(join(ROOT, "infrastructure/uptime-worker/src/index.ts"));

const chainDirs = {
  origin: join(ROOT, "observability/fixtures/edge.origin_unreachable/chain"),
  asset: join(ROOT, "observability/fixtures/edge.asset_failures/chain"),
  surge: join(ROOT, "observability/fixtures/release.failures_after_change/chain"),
};
const BASE = 1795176000000; // 2026-11-20T12:00:00Z
const BUCKET = 300_000;
const HOST = "api.chalkmeet.test";
const WEB = "chalkmeet.test";

/** @param {string} host @param {number} edgeStatus @param {number} originStatus @param {number} requests @param {string} path */
const group = (host, edgeStatus, originStatus, requests, path) => ({
  count: requests,
  sum: { requests },
  dimensions: {
    clientRequestHTTPHost: host,
    clientRequestPath: path,
    edgeResponseStatus: edgeStatus,
    originResponseStatus: originStatus,
    clientRequestHTTPMethodName: "GET",
    edgeResponseContentTypeName: "text/html",
    userAgentBot: 0,
  },
});

/**
 * Runs collectEdge once with GraphQL faked to return `groups`, captures every
 * posted row and re-stamps them deterministically: rollups at the bucket
 * start, ticks at the bucket close.
 */
let chainSeq = 0;

async function collectOnce(groups, { scheduledTime = BASE + 3 * BUCKET } = {}) {
  /** @type {Record<string, any>[]} */
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("api.cloudflare.com")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const data = body.query.includes("httpRequestsAdaptiveGroups")
        ? { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: groups }] } } }
        : { data: { viewer: { zones: [{ zoneTag: "zone1", name: "chalkmeet.test" }] } } };
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("api.axiom.co")) {
      posted.push(...JSON.parse(String(init?.body ?? "[]")));
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    await collectEdge(
      {
        CF_GRAPHQL_TOKEN: "chain",
        CHALK_AXIOM_INGEST_TOKEN: "chain",
        CHALK_INFRA_DATASET: "infra",
        CHALK_REQUESTS_DATASET: "requests",
        EDGE_HOSTS: HOST === "" ? "" : [HOST, WEB].join(","),
        EDGE_ENV: "test",
      },
      scheduledTime,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  return posted.map((row) => ({
    ...row,
    event_id: `chain-edge-${String((chainSeq += 1)).padStart(4, "0")}`,
    est_server_ms: row.name === "edge.collector_tick" ? Number(row.bucket_start_ms) + BUCKET : Number(row.bucket_start_ms ?? BASE),
  }));
}

/** collectOnce rows for one host only. @param {Record<string, any>[]} rows @param {string} host */
const forHost = (rows, host) => rows.filter((row) => row.host === host);

/** Runs one monitor cycle with the probe targets faked and returns the posted uptime rows, re-stamped a minute apart. */
async function monitorOnce(sickTarget) {
  const realFetch = globalThis.fetch;
  /** @type {Record<string, any>[]} */
  const captured = [];
  try {
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.includes("api.axiom.co")) {
        captured.push(...JSON.parse(String(init?.body ?? "[]")));
        return new Response("ok", { status: 200 });
      }
      if (target.includes("discord")) return new Response("ok", { status: 200 });
      const sick = sickTarget !== null && target.startsWith(sickTarget);
      return new Response(sick ? "unavailable" : "ok", { status: sick ? 503 : 200 });
    };
    await runMonitorCycle({
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/chain",
      API_BASE_URL: "https://api.chalkmeet.test",
      SYNC_BASE_URL: "https://sync.chalkmeet.test",
      EDGE_ENV: "test",
      CHALK_AXIOM_INGEST_TOKEN: "chain",
      CHALK_INFRA_DATASET: "infra",
    });
    let index = 0;
    return captured.map((row) => ({ ...row, event_id: `chain-uptime-${String((index += 1)).padStart(4, "0")}`, est_server_ms: BASE + 2 * BUCKET + index * 60_000, duration_ms: 0 }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

function compare(dir, name, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(dir, name);
  if (process.env.CHALK_CHAIN_WRITE === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  let want;
  try {
    want = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return; // the hop has not written yet
  }
  assert.deepEqual(JSON.parse(text), want, `${path} is stale`);
}

test("edge collector chain rows", async (t) => {
  await t.test("origin", async () => {
    // Two consecutive counted buckets on the api host at 78% origin-failure share.
    const first = forHost(await collectOnce([group(HOST, 502, 0, 14, "/spaces"), group(HOST, 200, 200, 4, "/healthz")]), HOST);
    const second = forHost(await collectOnce([group(HOST, 502, 0, 12, "/spaces"), group(HOST, 200, 200, 3, "/healthz")], { scheduledTime: BASE + 4 * BUCKET }), HOST);
    compare(chainDirs.origin, "edge.fault.json", [...first, ...second]);
    const well = forHost(await collectOnce([group(HOST, 200, 200, 30, "/spaces"), group(HOST, 200, 200, 6, "/healthz")]), HOST);
    compare(chainDirs.origin, "edge.healthy.json", well);
    // Two consecutive uptime checks on the api host read the origin down.
    compare(chainDirs.origin, "uptime.fault.json", await monitorOnce("https://api.chalkmeet.test"));
    compare(chainDirs.origin, "uptime.healthy.json", await monitorOnce(null));
  });

  await t.test("asset", async () => {
    const first = forHost(await collectOnce([group(WEB, 404, 404, 12, "/assets/chunk-a.js"), group(WEB, 200, 200, 30, "/assets/app.js")]), WEB);
    const second = forHost(await collectOnce([group(WEB, 404, 404, 11, "/assets/chunk-a.js"), group(WEB, 200, 200, 31, "/assets/app.js")], { scheduledTime: BASE + 4 * BUCKET }), WEB);
    compare(chainDirs.asset, "edge.fault.json", [...first, ...second]);
    const well = forHost(await collectOnce([group(WEB, 200, 200, 40, "/assets/app.js")]), WEB);
    compare(chainDirs.asset, "edge.healthy.json", well);
  });

  await t.test("surge", async () => {
    // Fault: two counted buckets of edge 5xx an hour after the deploy marker.
    const first = forHost(await collectOnce([group(HOST, 500, 0, 14, "/v1/spaces"), group(HOST, 200, 200, 20, "/healthz")]), HOST);
    const second = forHost(await collectOnce([group(HOST, 500, 0, 12, "/v1/spaces"), group(HOST, 200, 200, 22, "/healthz")], { scheduledTime: BASE + 4 * BUCKET }), HOST);
    compare(chainDirs.surge, "edge.fault.json", [...first, ...second]);
    // Restart: 502s inside the marker's deploy span (buckets 11:55 and 12:00).
    const r1 = forHost(await collectOnce([group(HOST, 502, 0, 14, "/v1/spaces"), group(HOST, 200, 200, 20, "/healthz")], { scheduledTime: BASE + BUCKET }), HOST);
    const r2 = forHost(await collectOnce([group(HOST, 502, 0, 12, "/v1/spaces"), group(HOST, 200, 200, 22, "/healthz")], { scheduledTime: BASE + 2 * BUCKET }), HOST);
    compare(chainDirs.surge, "edge.restart.json", [...r1, ...r2]);
    const well = forHost(await collectOnce([group(HOST, 200, 200, 40, "/v1/spaces"), group(HOST, 200, 200, 8, "/healthz")]), HOST);
    compare(chainDirs.surge, "edge.healthy.json", well);
  });
});
