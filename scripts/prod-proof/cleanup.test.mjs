import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupByRunId, sweepStaleRuns, cleanupRun } from "./cleanup.mjs";
import { createRun, recordResult, request, errorEvidence } from "./runtime.mjs";

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { api_url: origin, webhook_service_url: origin, web_url: origin, tenant_id: "tenant", api_key: "bootstrap" };
}

test("cleanup rediscovers lost responses, revokes first and is repeatable after abort", async (t) => {
  const calls = [];
  let revoked = false;
  let ended = false;
  let archived = false;
  let deleted = false;
  let webhookDeleted = false;
  const runId = "canceled-run";
  const label = `chalk-proof:${runId}`;
  const catcher = "12345678-1234-1234-1234-123456789abc";
  const config = await fixture(t, (req, res) => {
    const url = new URL(req.url, "http://local");
    const path = url.pathname;
    calls.push([req.method, path]);
    let value;
    if (req.headers.authorization === "Bearer temporary") {
      res.writeHead(revoked ? 401 : 200).end("{}");
      return;
    }
    if (req.method === "DELETE") {
      if (path.endsWith("/api-keys/key")) revoked = true;
      if (path.endsWith("/transcripts/transcript")) deleted = true;
      if (path.endsWith("/webhook-endpoints/hook")) webhookDeleted = true;
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST") {
      if (path.endsWith("/end")) ended = true;
      if (path.endsWith("/archive")) archived = true;
      value = {};
    } else if (path.endsWith("/api-keys")) value = { api_keys: [{ id: "key", name: label, revoked_at: revoked ? "now" : null }], pagination: {} };
    else if (path.endsWith("/spaces")) value = { spaces: [{ id: "space", name: label, metadata: { proof_run_id: runId }, archived }], pagination: {} };
    else if (path.endsWith("/episodes")) value = { episodes: [{ id: "episode", metadata: { proof_run_id: runId }, status: ended ? "ended" : "live" }], pagination: {} };
    else if (path.endsWith("/episodes/episode")) value = { status: ended ? "ended" : "live" };
    else if (path.endsWith("/spaces/space")) value = { archived };
    else if (path.endsWith("/transcripts")) value = { transcripts: [{ id: "transcript", space_id: "space", status: deleted ? "deleted" : "complete" }], pagination: {} };
    else if (path.endsWith("/webhook-endpoints")) value = { webhook_endpoints: webhookDeleted ? [] : [{ id: "hook", name: `${label}:${catcher}`, revision: 1 }], page: {} };
    else {
      res.writeHead(500).end("{}");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  const directory = await mkdtemp(join(tmpdir(), "proof-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  const run = await createRun(config, directory, controller.signal, runId);
  run.apiKey = "temporary";
  await cleanupRun(run);
  assert.equal(calls.find(([method]) => method !== "GET")[1], "/v1/tenants/tenant/api-keys/key");
  assert.ok(revoked && ended && archived && deleted && webhookDeleted);
  assert.deepEqual(JSON.parse(await readFile(`${directory}/key-rejection.json`)), { status: 401 });
  await cleanupByRunId(config, runId);
});

test("sweep follows pagination, cleans only old proof labels and does not use foreign names", async (t) => {
  const cleaned = [];
  const now = Date.now();
  const config = await fixture(t, (req, res) => {
    const url = new URL(req.url, "http://local");
    let value;
    if (req.method === "DELETE") {
      cleaned.push(url.pathname);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname.endsWith("/api-keys")) {
      value = url.searchParams.has("cursor")
        ? { api_keys: [{ id: "old", name: "chalk-proof:old", created_at: new Date(now - 3 * 3600_000).toISOString() }], pagination: {} }
        : {
            api_keys: [
              { id: "fresh", name: "chalk-proof:fresh", created_at: new Date(now).toISOString() },
              { id: "foreign", name: "unrelated", created_at: new Date(0).toISOString() },
            ],
            pagination: { next_cursor: "second" },
          };
    } else if (url.pathname.endsWith("/spaces")) value = { spaces: [], pagination: {} };
    else value = { webhook_endpoints: [], page: {} };
    res.end(JSON.stringify(value));
  });
  await sweepStaleRuns(config, now);
  assert.deepEqual(cleaned, ["/v1/tenants/tenant/api-keys/old"]);
});

test("malformed HTTP and thrown browser errors remain private in real proof reporting", async (t) => {
  const marker = "private-credential-and-production-url";
  const config = await fixture(t, (_req, res) => res.end(`not-json-${marker}`));
  const directory = await mkdtemp(join(tmpdir(), "proof-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = [];
  const original = { log: console.log, error: console.error };
  console.log = (line) => output.push(line);
  console.error = (line) => output.push(line);
  t.after(() => Object.assign(console, original));
  const report = { proofs: {} };
  await recordResult({ directory }, report, "export", () => request(config, "GET", "/malformed"));
  await recordResult({ directory }, report, "camera-share", async () => {
    throw new Error(`page.evaluate: ${marker}`);
  });
  assert.equal(
    output.some((line) => line.includes(marker)),
    false,
  );
  assert.ok(output.includes("PROOF export: failed (SyntaxError)"));
  assert.ok(output.includes("PROOF camera-share: failed (Error)"));
  assert.match(await readFile(`${directory}/report.json`, "utf8"), /page.evaluate: private-credential/);
});

test("sweep skips fully cleaned retained history without per-run reads", async (t) => {
  const reads = [];
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  const config = await fixture(t, (req, res) => {
    reads.push(req.url);
    assert.equal(req.method, "GET");
    const history = Array.from({ length: 50 }, (_, index) => ({ name: `chalk-proof:completed-${index}`, created_at: old }));
    if (req.url.includes("/api-keys")) res.end(JSON.stringify({ api_keys: history.map((entry) => ({ ...entry, revoked_at: old })), pagination: {} }));
    else if (req.url.includes("/spaces")) res.end(JSON.stringify({ spaces: history.map((entry) => ({ ...entry, archived: true })), pagination: {} }));
    else res.end(JSON.stringify({ webhook_endpoints: [], page: {} }));
  });
  await sweepStaleRuns(config);
  assert.equal(reads.length, 3);
});

test("sweep failures preserve the private nested HTTP cause", async (t) => {
  const config = await fixture(t, (req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(403).end(JSON.stringify({ error: { code: "private-code" } }));
      return;
    }
    if (req.url.includes("/api-keys")) res.end(JSON.stringify({ api_keys: [{ id: "key", name: "chalk-proof:failed", created_at: new Date(0).toISOString() }], pagination: {} }));
    else if (req.url.includes("/spaces")) res.end(JSON.stringify({ spaces: [], pagination: {} }));
    else res.end(JSON.stringify({ webhook_endpoints: [], page: {} }));
  });
  await assert.rejects(sweepStaleRuns(config), (error) => {
    assert.match(JSON.stringify(errorEvidence(error)), /HTTP 403, private-code/);
    return true;
  });
});
