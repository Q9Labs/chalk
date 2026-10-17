import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { check, request, save, waitFor, errorEvidence } from "./runtime.mjs";
import { rotateAndPatchEndpoint } from "./webhook-endpoint.mjs";

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
export async function cleanupByRunId(config, runId, directory = resolve(".private", "prod-proof", runId), ownership = {}) {
  const label = runLabel(runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
        results.push({
          kind,
          id,
          result: "failed",
          error: errorEvidence(error),
        });
        failures.push(error);
      }
    }
  };
  let known = {};
  await attempt("ownership", runId, async () => {
    known = await readOwnership(directory);
  });
  known = { ...known, ...ownership };
  // Persisted IDs avoid requiring inventory scopes on the bootstrap key.
  if (known.keyId) await attempt("api-key", known.keyId, () => call("DELETE", `${base}/api-keys/${known.keyId}`));
  await attempt("spaces", runId, async () => {
    const spaces = (await list(call, `${base}/spaces`, "spaces")).filter((space) => space.name === label && space.metadata?.proof_run_id === runId);
    for (const space of spaces) {
      const before = failures.length;
      await attempt("episodes", space.id, async () => {
        const path = `${base}/spaces/${space.id}/episodes`;
        const episodes = await list(call, path, "episodes");
        for (const episode of episodes.filter((episode) => episode.metadata?.proof_run_id === runId)) {
          await attempt("episode", episode.id, async () => {
            await endEpisode(call, path, episode);
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
  await cleanupWebhook(call, config, known, base, attempt);
  await save(`${directory}/remote-cleanup.json`, results);
  if (failures.length) throw new AggregateError(failures, "Remote cleanup failed");
  return results;
}
async function cleanupWebhook(call, config, known, base, attempt) {
  const endpointId = config.webhook_endpoint_id;
  if (endpointId) {
    await attempt("webhook-endpoint", endpointId, async () => {
      const endpoint = await rotateAndPatchEndpoint(call, `${base}/webhook-endpoints/${endpointId}`, { enabled: false });
      check(endpoint.enabled === false, "Webhook endpoint not disabled");
    });
  }
  if (known.webhook?.catcherId) {
    const { catcherId } = known.webhook;
    await attempt("webhook-catcher", catcherId, async () => {
      const response = await fetch(new URL(`/token/${catcherId}`, config.webhook_service_url), { method: "DELETE", signal: AbortSignal.timeout(15_000) });
      await response.body?.cancel();
      check([response.ok, response.status === 404].some(Boolean), "Catcher deletion failed");
    });
  }
}
async function readOwnership(directory) {
  try {
    const ownership = JSON.parse(await readFile(`${directory}/ownership.json`, "utf8"));
    check(Object.getPrototypeOf(ownership) === Object.prototype, "Corrupt proof ownership");
    return ownership;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
export async function sweepStaleRuns(config, now = Date.now()) {
  const call = cleanupClient(config);
  const base = `/v1/tenants/${config.tenant_id}`;
  const spaces = await list(call, `${base}/spaces`, "spaces");
  for (const space of spaces.filter(isProofSpace)) {
    const runId = space.metadata.proof_run_id;
    runLabel(runId);
    await sweepSpace(call, base, space, runId, now);
  }
}
function isProofSpace(space) {
  const runId = space.metadata?.proof_run_id;
  return [!space.archived, Boolean(runId), space.name === `chalk-proof:${runId}`].every(Boolean);
}
async function endEpisode(call, path, episode) {
  if (episode.status !== "ended") await call("POST", `${path}/${episode.id}/end`, {});
  await waitFor("cleanup Episode ended", async () => (await call("GET", `${path}/${episode.id}`)).status === "ended", 60_000, 1000, AbortSignal.timeout(60_000));
}
async function sweepSpace(call, base, space, runId, now) {
  if (!(Date.parse(space.created_at) < now - 2 * 3600_000)) return;
  const path = `${base}/spaces/${space.id}/episodes`;
  const episodes = await list(call, path, "episodes");
  const owned = episodes.filter((episode) => episode.metadata?.proof_run_id === runId);
  const stale = owned.filter((episode) => Date.parse(episode.created_at) < now - 2 * 3600_000);
  for (const episode of stale) {
    await endEpisode(call, path, episode);
  }
  // Never archive a Space with a fresh or foreign Episode.
  if (stale.length !== episodes.length) return;
  await call("POST", `${base}/spaces/${space.id}/archive`, {});
  check((await call("GET", `${base}/spaces/${space.id}`)).archived, "Stale Space not archived");
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
  await cleanupByRunId(run.config, run.runId, run.directory, run.ownership).catch((error) => failures.push(error));
  await verifyKeyRejected(run).catch((error) => failures.push(error));
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
  await save(`${run.directory}/key-rejection.json`, {
    status: response.status,
  });
}
