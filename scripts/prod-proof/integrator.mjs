import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupRun, runLabel } from "./cleanup.mjs";
import { createIntegratorSession } from "./integrator-session.mjs";
import { installFixture } from "./fixture.mjs";
import { check, createRun, errorEvidence, loadConfig, request, save, saveOwnership } from "./runtime.mjs";

export function integratorBrowserSource(config) {
  return `import {createSpaceClient} from './sdks/typescript/client/src/index.ts'; import {prepareBrowser} from './scripts/prod-proof/integrator-browser.mjs'; prepareBrowser(createSpaceClient,${installFixture.toString()},${JSON.stringify(config)}).catch(()=>{document.querySelector('pre').textContent='Media or client setup failed';});`;
}

async function readAccessRequest(incoming) {
  let body = "";
  for await (const chunk of incoming) {
    body += chunk;
    check(body.length <= 4096, "Access request too large", "configuration");
  }
  const input = JSON.parse(body);
  check(typeof input === "object", "Invalid access request", "configuration");
  check(input !== null, "Invalid access request", "configuration");
  for (const [field, type] of [
    ["replaceMediaConnection", "boolean"],
    ["expectedMediaConnectionId", "string"],
    ["currentMediaToken", "string"],
  ]) {
    check(input[field] === undefined || typeof input[field] === type, "Invalid access request", "configuration");
  }
  return input;
}

function serveIntegratorPage(path, response, session, bundle) {
  const html = '<!doctype html><title>Chalk integrator proof</title><h1>Chalk integrator proof</h1><button disabled>Join owned fixture</button><pre>Preparing both clients</pre><script src="/client.js"></script>';
  const pages = new Map([
    ["/guest1", ["text/html", html]],
    ["/guest2", ["text/html", html]],
    ["/client.js", ["text/javascript", bundle]],
    ["/status", ["application/json", JSON.stringify({ ready: session.ready })]],
  ]);
  const page = pages.get(path);
  if (!page) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": page[0] }).end(page[1]);
}

async function serveIntegratorAccess(path, incoming, response, session) {
  const action = /^\/(ready|access)\/([12])$/.exec(path);
  if (incoming.method !== "POST" || !action) {
    response.writeHead(404).end();
    return;
  }
  const guest = Number(action[2]);
  if (action[1] === "ready") {
    session.markReady(guest);
    response.writeHead(204).end();
    return;
  }
  const grant = await session.getAccess(guest, await readAccessRequest(incoming));
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(grant));
}

function validIntegratorOrigin(incoming, origin) {
  return incoming.headers.host === new URL(origin).host && (incoming.method !== "POST" || incoming.headers.origin === origin);
}

function replyIntegratorError(response, error) {
  if (error.status === 409) {
    response.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "clients_not_ready" }));
    return;
  }
  const status = error instanceof SyntaxError || error.reason === "configuration" ? 400 : 502;
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture_request_failed" }));
}

export function integratorHandler({ session, origin, bundle }) {
  return async (incoming, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (!validIntegratorOrigin(incoming, origin)) {
        response.writeHead(403).end();
        return;
      }
      const path = new URL(incoming.url, origin).pathname;
      if (incoming.method === "GET") serveIntegratorPage(path, response, session, bundle);
      else await serveIntegratorAccess(path, incoming, response, session);
    } catch (error) {
      replyIntegratorError(response, error);
    }
  };
}

async function createIntegratorFixture(run) {
  const key = await run.ownerRequest("POST", `${run.tenantPath}/api-keys`, {
    name: run.label,
    scopes: ["spaces:read", "spaces:write", "episodes:read", "episodes:write"],
    expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
  });
  run.ownership.keyId = key.api_key.id;
  run.apiKey = key.secret;
  await saveOwnership(run);
  run.apiRequest = (method, path, body) => request(run.config, method, path, body, { Authorization: `Bearer ${run.apiKey}` });
  return run.apiRequest("POST", `${run.tenantPath}/spaces`, {
    name: run.label,
    slug: `prod-proof-${randomUUID()}`,
    metadata: { proof_run_id: run.runId },
    media_plane: "cf_sfu",
    recording_policy: "manual",
    transcription_policy: "on_demand",
    default_episode_duration_seconds: 1800,
    maximum_episode_duration_seconds: 1800,
    linger_window_seconds: 60,
    admission_policy: { mode: "open" },
  });
}

export function createIntegratorAccessSession(run, space, chalk, getAccessRefreshState) {
  return createIntegratorSession({
    createEpisode: async () => {
      const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: run.runId } });
      await save(`${run.directory}/integrator-fixture.json`, { run_id: run.runId, space_id: space.id, episode_id: episode.id, episode_created_at: new Date().toISOString() });
      return episode;
    },
    admit: async (episode, guest) => {
      const admission = await chalk.participants.admit(space.id, episode.id, { name: `Integrator guest ${guest}`, role: "owner" });
      await save(`${run.directory}/integrator-guest-${guest}.json`, { participant_id: admission.participant.id, admitted_at: new Date().toISOString() });
      return admission;
    },
    refresh: (episode, admission, input) =>
      chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(admission.access), { replaceMediaConnection: input.replaceMediaConnection, expectedMediaConnectionId: input.expectedMediaConnectionId, currentMediaToken: input.currentMediaToken }),
  });
}

async function startIntegratorServer(run, origin) {
  const { build } = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url))("esbuild");
  const space = await createIntegratorFixture(run);
  const serverPath = `${run.directory}/sdk-server.mjs`;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  await build({ entryPoints: [`${root}/sdks/typescript/client/src/server/index.ts`], bundle: true, outfile: serverPath, format: "esm", platform: "node", logLevel: "silent" });
  const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(serverPath).href);
  const chalk = createChalkServerClient({ apiKey: run.apiKey, tenantId: run.config.tenant_id, apiBaseURL: run.config.api_url, headers: { "User-Agent": "Chalk-Production-Proof/1.0" }, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }) });
  const session = createIntegratorAccessSession(run, space, chalk, getAccessRefreshState);
  const bundled = await build({
    stdin: { contents: integratorBrowserSource({ api: run.config.api_url, slug: space.slug }), resolveDir: root, sourcefile: "integrator-browser.js" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });
  const server = createServer(integratorHandler({ session, origin: origin.origin, bundle: bundled.outputFiles[0].text }));
  server.requestTimeout = 30_000;
  server.listen(Number(origin.port), "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function main() {
  const config = await loadConfig();
  const origin = new URL(config.proof_origin);
  check(origin.protocol === "http:" && origin.hostname === "127.0.0.1", "proof_origin must use HTTP 127.0.0.1");
  check(Number(origin.port) > 0, "proof_origin must have an explicit port");
  check(origin.href === `${origin.origin}/`, "proof_origin must not include a path, query, or credentials");
  const runId = process.env.CHALK_PROOF_RUN_ID ?? `integrator-${randomUUID()}`;
  runLabel(runId);
  const run = await createRun(config, resolve(".private", "prod-proof", runId), undefined, runId);
  let server;
  let stopping;
  let setupDone;
  const setupComplete = new Promise((done) => {
    setupDone = done;
  });
  const stop = () =>
    (stopping ??= (async () => {
      if (server?.listening) await new Promise((done) => server.close(done));
      await cleanupRun(run);
    })());
  const onSignal = () => {
    void setupComplete.then(stop).catch(() => {
      console.error("Integrator cleanup failed; see private evidence");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    server = await startIntegratorServer(run, origin);
    console.log(`Run the integrator proof alone. Open ${origin.origin}/guest1 and ${origin.origin}/guest2, prepare both, then Join both promptly.`);
    console.log(`Private evidence: ${run.directory}. Ctrl-C cleans up this run's resources.`);
  } catch (error) {
    await save(`${run.directory}/integrator-error.json`, errorEvidence(error));
    await stop();
    throw error;
  } finally {
    setupDone();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) console.log("Manual hosted integrator proof: node scripts/prod-proof/integrator.mjs\nRun alone, using the same configuration as pnpm prod:proof. Prepare /guest1 and /guest2 before Join. Ctrl-C cleans up owned resources.");
  else
    await main().catch(() => {
      console.error("Integrator proof failed; see private evidence");
      process.exitCode = 1;
    });
}
