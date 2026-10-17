import { check, request, save, waitFor, errorEvidence } from "./runtime.mjs";

export function runLabel(runId) {
  check(/^[A-Za-z0-9_-]{1,51}$/.test(runId), "Invalid proof run ID");
  return `chalk-proof:${runId}`;
}
function cleanupClient(config) {
  // Never inherit the proof's aborted signal. Every HTTP operation has a deadline.
  return (method, path, body, headers) => request(config, method, path, body, { Authorization: `Bearer ${config.api_key}` }, headers, AbortSignal.timeout(15_000));
}
async function list(call, path, field) {
  const values = [];
  let cursor = "";
  do {
    const query = new URLSearchParams({ page_size: "100", cursor });
    const page = await call("GET", `${path}?${query}`);
    check(Array.isArray(page[field]), "Invalid cleanup listing");
    values.push(...page[field]);
    cursor = (page.pagination ?? page.page).next_cursor;
  } while (cursor);
  return values;
}
export async function cleanupByRunId(config, runId, directory) {
  const label = runLabel(runId);
  const call = cleanupClient(config);
  const base = `/v1/tenants/${config.tenant_id}`;
  const results = [];
  const failures = [];
  const attempt = async (kind, id, action) => {
    try {
      await action();
      results.push({ kind, id, result: "passed" });
    } catch (error) {
      if (error.status === 404) results.push({ kind, id, result: "absent" });
      else {
        results.push({ kind, id, result: "failed", error: errorEvidence(error) });
        failures.push(error);
      }
    }
  };
  // Revoke first, before waiting for Episode shutdown or touching local processes.
  await attempt("api-keys", runId, async () => {
    const keys = await list(call, `${base}/api-keys`, "api_keys");
    for (const key of keys.filter((key) => key.name === label && !key.revoked_at)) {
      await attempt("api-key", key.id, () => call("DELETE", `${base}/api-keys/${key.id}`));
    }
  });
  await attempt("spaces", runId, async () => {
    const spaces = (await list(call, `${base}/spaces`, "spaces")).filter((space) => space.name === label && space.metadata?.proof_run_id === runId);
    for (const space of spaces) {
      const before = failures.length;
      await attempt("episodes", space.id, async () => {
        const path = `${base}/spaces/${space.id}/episodes`;
        const episodes = await list(call, path, "episodes");
        for (const episode of episodes.filter((episode) => episode.metadata?.proof_run_id === runId)) {
          await attempt("episode", episode.id, async () => {
            if (episode.status !== "ended") await call("POST", `${path}/${episode.id}/end`, {});
            await waitFor("cleanup Episode ended", async () => (await call("GET", `${path}/${episode.id}`)).status === "ended", 60_000, 1000, AbortSignal.timeout(60_000));
          });
        }
      });
      await attempt("transcripts", space.id, async () => {
        const transcripts = await list(call, `${base}/transcripts`, "transcripts");
        for (const transcript of transcripts.filter((entry) => entry.space_id === space.id && entry.status !== "deleted")) {
          await attempt("transcript", transcript.id, () => call("DELETE", `${base}/transcripts/${transcript.id}`));
        }
      });
      if (failures.length === before) {
        await attempt("space", space.id, async () => {
          if (!space.archived) await call("POST", `${base}/spaces/${space.id}/archive`, {});
          check((await call("GET", `${base}/spaces/${space.id}`)).archived, "Space not archived");
        });
      }
    }
  });
  await attempt("webhooks", runId, async () => {
    const endpoints = await list(call, `${base}/webhook-endpoints`, "webhook_endpoints");
    for (const endpoint of endpoints.filter((entry) => entry.name.startsWith(`${label}:`))) {
      const catcherId = endpoint.name.slice(label.length + 1);
      check(/^[0-9a-f-]{36}$/.test(catcherId), "Invalid proof catcher ID");
      // Delete the catcher first, retaining its label on the endpoint if deletion fails.
      const before = failures.length;
      await attempt("webhook-catcher", catcherId, async () => {
        const response = await fetch(new URL(`/token/${catcherId}`, config.webhook_service_url), { method: "DELETE", signal: AbortSignal.timeout(15_000) });
        await response.body?.cancel();
        check(response.ok || response.status === 404, "Catcher deletion failed");
      });
      if (failures.length === before) await attempt("webhook-endpoint", endpoint.id, () => call("DELETE", `${base}/webhook-endpoints/${endpoint.id}`, undefined, { "If-Match": `"${endpoint.revision}"` }));
    }
  });
  if (directory) await save(`${directory}/remote-cleanup.json`, results);
  if (failures.length) throw new AggregateError(failures, "Remote cleanup failed");
  return results;
}
function staleRun(entry, route, now) {
  const completed = { "api-keys": Boolean(entry.revoked_at), spaces: entry.archived, "webhook-endpoints": false }[route];
  if (completed) return;
  const match = /^chalk-proof:([A-Za-z0-9_-]{1,51})(?::[0-9a-f-]{36})?$/.exec(entry.name);
  if (!match) return;
  if (Date.parse(entry.created_at) < now - 2 * 60 * 60 * 1000) return match[1];
}
export async function sweepStaleRuns(config, now = Date.now()) {
  const call = cleanupClient(config);
  const base = `/v1/tenants/${config.tenant_id}`;
  const runs = new Set();
  for (const [route, field] of [
    ["api-keys", "api_keys"],
    ["spaces", "spaces"],
    ["webhook-endpoints", "webhook_endpoints"],
  ]) {
    const entries = await list(call, `${base}/${route}`, field);
    const staleIds = entries.map((entry) => staleRun(entry, route, now)).filter(Boolean);
    staleIds.forEach((runId) => runs.add(runId));
  }
  for (const runId of runs) await cleanupByRunId(config, runId);
}

async function disposeResource(run, resource) {
  let timer;
  try {
    await Promise.race([
      resource.dispose(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Local cleanup timed out")), 15_000);
      }),
    ]);
    run.cleanup.push({ kind: resource.kind, result: "passed" });
    return [];
  } catch (error) {
    run.cleanup.push({ kind: resource.kind, result: "failed" });
    return [new Error(`${resource.kind}: ${error.message}`)];
  } finally {
    clearTimeout(timer);
  }
}
export async function cleanupRun(run) {
  const failures = [];
  try {
    await cleanupByRunId(run.config, run.runId, run.directory);
    await verifyKeyRejected(run);
  } catch (error) {
    failures.push(error);
  }
  // Remote ownership cleanup is independent of browsers and the aborted proof signal.
  for (const resource of [...run.resources].reverse()) failures.push(...(await disposeResource(run, resource)));
  await save(`${run.directory}/cleanup.json`, run.cleanup);
  if (failures.length) throw new AggregateError(failures, "Run cleanup failed; see private evidence");
}

async function verifyKeyRejected(run) {
  if (!run.apiKey) return;
  const response = await fetch(new URL(`${run.tenantPath}/spaces`, run.config.api_url), {
    headers: { Authorization: `Bearer ${run.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  check(response.status === 401, "Revoked proof key was still accepted");
  await save(`${run.directory}/key-rejection.json`, { status: response.status });
}
