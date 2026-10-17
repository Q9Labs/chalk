import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  return {
    api_url: origin,
    webhook_service_url: origin,
    web_url: origin,
    tenant_id: "tenant",
    api_key: "bootstrap",
  };
}

test("cleanup uses persisted IDs, revokes first and is repeatable after abort", async (t) => {
  const calls = [];
  let revoked = false;
  let ended = false;
  let archived = false;
  let deleted = false;
  let webhookDisabled = false;
  const runId = "canceled-run";
  const label = `chalk-proof:${runId}`;
  const catcher = "12345678-1234-1234-1234-123456789abc";
  const state = {
    keyStatus: 200,
    episodeStatus: "live",
    transcriptStatus: "complete",
  };
  const base = "/v1/tenants/tenant";
  const routes = {
    [`GET ${base}/spaces`]: () => ({
      spaces: [
        {
          id: "space",
          name: label,
          metadata: { proof_run_id: runId },
          archived,
        },
      ],
      pagination: {},
    }),
    [`GET ${base}/spaces/space/episodes`]: () => ({
      episodes: [
        {
          id: "episode",
          metadata: { proof_run_id: runId },
          status: state.episodeStatus,
        },
      ],
      pagination: {},
    }),
    [`GET ${base}/spaces/space/episodes/episode`]: () => ({
      status: state.episodeStatus,
    }),
    [`GET ${base}/spaces/space`]: () => ({ archived }),
    [`GET ${base}/transcripts`]: () => ({
      transcripts: [{ id: "transcript", space_id: "space", status: state.transcriptStatus }],
      pagination: {},
    }),
    [`DELETE ${base}/api-keys/key`]: () => {
      revoked = true;
      state.keyStatus = 401;
    },
    [`DELETE ${base}/transcripts/transcript`]: () => {
      deleted = true;
      state.transcriptStatus = "deleted";
    },
    [`POST ${base}/webhook-endpoints/hook/rotate-secret`]: () => ({ revision: 5, secret: "rotated" }),
    [`PATCH ${base}/webhook-endpoints/hook`]: () => {
      webhookDisabled = true;
      return { enabled: false };
    },
    [`DELETE /token/${catcher}`]: () => {},
    [`POST ${base}/spaces/space/episodes/episode/end`]: () => {
      ended = true;
      state.episodeStatus = "ended";
      return {};
    },
    [`POST ${base}/spaces/space/archive`]: () => {
      archived = true;
      return {};
    },
  };
  const config = await fixture(t, (req, res) => {
    const path = new URL(req.url, "http://local").pathname;
    calls.push([req.method, path]);
    if (req.headers.authorization === "Bearer temporary") {
      res.writeHead(state.keyStatus).end("{}");
      return;
    }
    const execute = routes[`${req.method} ${path}`];
    assert.ok(execute, `Unexpected request: ${req.method} ${path}`);
    const value = execute();
    if (value === undefined) res.writeHead(204).end();
    else res.end(JSON.stringify(value));
  });
  const directory = await mkdtemp(join(tmpdir(), "proof-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  const run = await createRun(config, directory, controller.signal, runId);
  await writeFile(
    `${directory}/ownership.json`,
    JSON.stringify({
      keyId: "key",
      webhook: { id: "hook", revision: 1, catcherId: catcher },
    }),
  );
  run.apiKey = "temporary";
  await cleanupRun(run);
  assert.equal(calls.find(([method]) => method !== "GET")[1], "/v1/tenants/tenant/api-keys/key");
  assert.ok(revoked);
  assert.ok(ended);
  assert.ok(archived);
  assert.ok(deleted);
  assert.ok(webhookDisabled);
  assert.deepEqual(JSON.parse(await readFile(`${directory}/key-rejection.json`)), { status: 401 });
  await cleanupByRunId(config, runId, directory);
});

function sweepSpacesPage(url) {
  const space = (id, name = `chalk-proof:${id}`) => ({ id, name, metadata: { proof_run_id: id } });
  return {
    "": { spaces: [space("fresh"), space("foreign", "unrelated")], pagination: { next_cursor: "second" } },
    second: { spaces: [space("old")], pagination: {} },
  }[url.searchParams.get("cursor") ?? ""];
}
function sweepPage(url, old) {
  const path = url.pathname;
  if (path.endsWith("/spaces")) return sweepSpacesPage(url);
  if (path.endsWith("/episodes")) {
    const id = path.split("/").at(-2);
    const created_at = { fresh: new Date().toISOString(), old }[id];
    return { episodes: [{ id: "ep", metadata: { proof_run_id: id }, created_at, status: "live" }], pagination: {} };
  }
  return { ep: { status: "ended" }, old: { archived: true } }[path.split("/").at(-1)];
}
test("sweep uses only Spaces and Episodes, follows pagination and preserves fresh/foreign resources", async (t) => {
  const changed = [];
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  const config = await fixture(t, (req, res) => {
    const url = new URL(req.url, "http://local");
    if (req.method === "POST") {
      changed.push(url.pathname);
      res.end("{}");
      return;
    }
    const page = sweepPage(url, old);
    assert.ok(page, `Unexpected inventory request: ${url.pathname}`);
    res.end(JSON.stringify(page));
  });
  await sweepStaleRuns(config);
  assert.deepEqual(changed, ["/v1/tenants/tenant/spaces/old/episodes/ep/end", "/v1/tenants/tenant/spaces/old/archive"]);
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
    const history = Array.from({ length: 50 }, (_, index) => ({
      name: `chalk-proof:completed-${index}`,
      created_at: old,
    }));
    assert.ok(req.url.includes("/spaces"));
    res.end(JSON.stringify({ spaces: history.map((entry) => ({ ...entry, archived: true })), pagination: {} }));
  });
  await sweepStaleRuns(config);
  assert.equal(reads.length, 1);
});

test("sweep failures preserve the private HTTP cause", async (t) => {
  const config = await fixture(t, (_req, res) => res.writeHead(403).end(JSON.stringify({ error: { code: "private-code" } })));
  await assert.rejects(sweepStaleRuns(config), (error) => {
    assert.match(JSON.stringify(errorEvidence(error)), /HTTP 403, private-code/);
    return true;
  });
});

test("truncated ownership reports failure but in-memory key, endpoint, Spaces and local cleanup still run", async (t) => {
  const calls = [];
  const config = await fixture(t, (req, res) => {
    const path = new URL(req.url, "http://local").pathname;
    calls.push(`${req.method} ${path}`);
    if (req.headers.authorization === "Bearer temporary") res.writeHead(401).end("{}");
    else if (req.method === "DELETE") res.writeHead(204).end();
    else if (path.endsWith("/spaces")) res.end(JSON.stringify({ spaces: [], pagination: {} }));
    else if (path.endsWith("/rotate-secret")) res.end(JSON.stringify({ revision: 9, secret: "rotated" }));
    else {
      assert.equal(req.method, "PATCH");
      assert.equal(req.headers["if-match"], '"9"');
      res.end(JSON.stringify({ enabled: false }));
    }
  });
  config.webhook_endpoint_id = "hook";
  const directory = await mkdtemp(join(tmpdir(), "proof-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = await createRun(config, directory, undefined, "truncated");
  run.ownership = { keyId: "key", webhook: { id: "hook", catcherId: "catcher" } };
  run.apiKey = "temporary";
  let disposed = false;
  run.resources.push({
    kind: "local",
    dispose: () => {
      disposed = true;
    },
  });
  await writeFile(`${directory}/ownership.json`, '{"keyId":');
  await assert.rejects(cleanupRun(run), /Run cleanup failed/);
  assert.ok(disposed);
  assert.ok(calls.includes("DELETE /v1/tenants/tenant/api-keys/key"));
  assert.ok(calls.includes("GET /v1/tenants/tenant/spaces"));
  assert.ok(calls.includes("PATCH /v1/tenants/tenant/webhook-endpoints/hook"));
  assert.ok(calls.includes("DELETE /token/catcher"));
  assert.deepEqual(JSON.parse(await readFile(`${directory}/key-rejection.json`)), { status: 401 });
  const results = JSON.parse(await readFile(`${directory}/remote-cleanup.json`));
  assert.equal(results.find((entry) => entry.kind === "ownership").result, "failed");
  // Recovery without in-memory state still disables the configured endpoint and sweeps Spaces.
  calls.length = 0;
  await assert.rejects(cleanupByRunId(config, "truncated", directory), /Remote cleanup failed/);
  assert.ok(calls.includes("GET /v1/tenants/tenant/spaces"));
  assert.ok(calls.includes("PATCH /v1/tenants/tenant/webhook-endpoints/hook"));
});

test("sweep archives only old owned empty Spaces or Spaces whose Episodes are all stale and owned", async (t) => {
  const now = Date.now();
  const old = new Date(now - 3 * 3600_000).toISOString();
  const fresh = new Date(now).toISOString();
  const changed = [];
  const cases = [
    { id: "old-empty", created_at: old, episodes: [] },
    { id: "fresh-empty", created_at: fresh, episodes: [] },
    { id: "foreign-episode", created_at: old, episodes: [{ id: "ep", created_at: old, metadata: { proof_run_id: "another" } }] },
    { id: "fresh-episode", created_at: old, episodes: [{ id: "ep", created_at: fresh, metadata: { proof_run_id: "fresh-episode" } }] },
  ];
  const config = await fixture(t, (req, res) => {
    const path = new URL(req.url, "http://local").pathname;
    if (req.method === "POST") {
      changed.push(path);
      res.end("{}");
    } else if (path.endsWith("/spaces")) {
      res.end(JSON.stringify({ spaces: cases.map(({ id, created_at }) => ({ id, created_at, name: `chalk-proof:${id}`, metadata: { proof_run_id: id } })), pagination: {} }));
    } else if (path.endsWith("/episodes")) {
      res.end(JSON.stringify({ episodes: cases.find((entry) => entry.id === path.split("/").at(-2)).episodes, pagination: {} }));
    } else res.end(JSON.stringify({ archived: true }));
  });
  await sweepStaleRuns(config, now);
  assert.deepEqual(changed, ["/v1/tenants/tenant/spaces/old-empty/archive"]);
});
