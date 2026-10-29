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

async function prepareBrowser(createSpaceClient, installFixture, config) {
  const guest = Number(location.pathname.slice(-1));
  const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  for (const track of media.getTracks()) track.stop();
  installFixture({ guest: guest - 1, tones: true });
  window.proofHistory = [];
  window.proofAccessCalls = [];
  const client = createSpaceClient({
    space: config.slug,
    baseUrl: config.api,
    getAccess: async ({ reason, replaceMediaConnection }) => {
      const receipt = { at: new Date().toISOString(), reason, replaceMediaConnection };
      window.proofAccessCalls.push(receipt);
      const response = await fetch(`/access/${guest}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, replaceMediaConnection }),
      });
      receipt.status = response.status;
      if (!response.ok) throw new Error(`Proof access failed: ${response.status}`);
      const grant = await response.json();
      receipt.media_expires_at = grant.media.expires_at;
      receipt.sync_expires_at = grant.sync.expires_at;
      return grant;
    },
  });
  window.proofClient = client;
  client.subscribe(() => {
    const snapshot = client.getSnapshot();
    const row = { at: new Date().toISOString(), status: snapshot.connection.status, error: snapshot.connection.lastError?.code ?? null, participants: snapshot.participants.roster.length };
    window.proofHistory.push(row);
    document.querySelector("pre").textContent = JSON.stringify(row);
    for (const remote of snapshot.media.remote) {
      if (document.getElementById(`track-${remote.track.id}`)) continue;
      const element = document.createElement(remote.track.kind === "audio" ? "audio" : "video");
      element.id = `track-${remote.track.id}`;
      element.autoplay = true;
      element.playsInline = true;
      element.width = 240;
      element.volume = 0.001;
      element.srcObject = new MediaStream([remote.track]);
      document.body.append(element);
      void element.play().catch(() => {});
    }
  });
  window.proofStart = async () => {
    await client.join({ displayName: `Integrator guest ${guest}`, microphone: true, camera: true });
    window.proofJoinedAt = new Date().toISOString();
  };
  document.querySelector("button").onclick = () => {
    document.querySelector("button").disabled = true;
    void window.proofStart().catch(() => {
      document.querySelector("pre").textContent = "Join failed; inspect client history and network requests";
    });
  };
  window.proofReady = (async () => {
    const response = await fetch(`/ready/${guest}`, { method: "POST" });
    if (!response.ok) throw new Error("Could not mark proof client ready");
    while (true) {
      const statusResponse = await fetch("/status");
      if (!statusResponse.ok) throw new Error("Could not read proof readiness");
      if ((await statusResponse.json()).ready) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    document.querySelector("button").disabled = false;
    document.querySelector("pre").textContent = "Both clients ready. Join both promptly.";
  })();
  void window.proofReady.catch(() => {
    document.querySelector("pre").textContent = "Client setup failed";
  });
}

export function integratorBrowserSource(config) {
  return `import {createSpaceClient} from './sdks/typescript/client/src/index.ts'; (${prepareBrowser.toString()})(createSpaceClient,${installFixture.toString()},${JSON.stringify(config)}).catch(()=>{document.querySelector('pre').textContent='Media or client setup failed';});`;
}

export function integratorHandler({ session, origin, bundle }) {
  const html = '<!doctype html><title>Chalk integrator proof</title><h1>Chalk integrator proof</h1><button disabled>Join owned fixture</button><pre>Preparing both clients</pre><script src="/client.js"></script>';
  return async (incoming, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (incoming.headers.host !== new URL(origin).host || (incoming.method === "POST" && incoming.headers.origin !== origin)) {
        response.writeHead(403).end();
        return;
      }
      const path = new URL(incoming.url, origin).pathname;
      if (incoming.method === "GET" && /^\/guest[12]$/.test(path)) {
        response.writeHead(200, { "Content-Type": "text/html" }).end(html);
      } else if (incoming.method === "GET" && path === "/client.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle);
      } else if (incoming.method === "GET" && path === "/status") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ready: session.ready }));
      } else if (incoming.method === "POST" && /^\/ready\/[12]$/.test(path)) {
        session.markReady(Number(path.slice(-1)));
        response.writeHead(204).end();
      } else if (incoming.method === "POST" && /^\/access\/[12]$/.test(path)) {
        let body = "";
        for await (const chunk of incoming) {
          body += chunk;
          check(body.length <= 4096, "Access request too large", "configuration");
        }
        const input = JSON.parse(body);
        check(typeof input === "object" && input !== null && (input.replaceMediaConnection === undefined || typeof input.replaceMediaConnection === "boolean"), "Invalid access request", "configuration");
        const grant = await session.getAccess(Number(path.slice(-1)), input);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(grant));
      } else response.writeHead(404).end();
    } catch (error) {
      const status = error.status === 409 ? 409 : error instanceof SyntaxError || error.reason === "configuration" ? 400 : 502;
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: status === 409 ? "clients_not_ready" : "fixture_request_failed" }));
    }
  };
}

async function main() {
  const config = await loadConfig();
  const origin = new URL(config.proof_origin);
  check(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && Number(origin.port) > 0 && origin.href === `${origin.origin}/`, "proof_origin must be an HTTP 127.0.0.1 origin with an explicit port");
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
    const { build } = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url))("esbuild");
    const key = await run.ownerRequest("POST", `${run.tenantPath}/api-keys`, {
      name: run.label,
      scopes: ["spaces:read", "spaces:write", "episodes:read", "episodes:write"],
      expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    });
    run.ownership.keyId = key.api_key.id;
    run.apiKey = key.secret;
    await saveOwnership(run);
    const call = (method, path, body) => request(config, method, path, body, { Authorization: `Bearer ${run.apiKey}` });
    const space = await call("POST", `${run.tenantPath}/spaces`, {
      name: run.label,
      slug: `prod-proof-${randomUUID()}`,
      metadata: { proof_run_id: runId },
      media_plane: "cf_sfu",
      recording_policy: "manual",
      transcription_policy: "on_demand",
      default_episode_duration_seconds: 1800,
      maximum_episode_duration_seconds: 1800,
      linger_window_seconds: 60,
      admission_policy: { mode: "open" },
    });
    const serverPath = `${run.directory}/sdk-server.mjs`;
    const root = fileURLToPath(new URL("../../", import.meta.url));
    await build({ entryPoints: [`${root}/sdks/typescript/client/src/server/index.ts`], bundle: true, outfile: serverPath, format: "esm", platform: "node", logLevel: "silent" });
    const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(serverPath).href);
    const chalk = createChalkServerClient({ apiKey: run.apiKey, tenantId: config.tenant_id, apiBaseURL: config.api_url, headers: { "User-Agent": "Chalk-Production-Proof/1.0" }, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }) });
    const session = createIntegratorSession({
      createEpisode: async () => {
        const episode = await call("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: runId } });
        await save(`${run.directory}/integrator-fixture.json`, { run_id: runId, space_id: space.id, episode_id: episode.id, episode_created_at: new Date().toISOString() });
        return episode;
      },
      admit: async (episode, guest) => {
        const admission = await chalk.participants.admit(space.id, episode.id, { name: `Integrator guest ${guest}`, role: "owner" });
        await save(`${run.directory}/integrator-guest-${guest}.json`, { participant_id: admission.participant.id, admitted_at: new Date().toISOString() });
        return admission;
      },
      refresh: (episode, admission, input) => chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(admission.access), { replaceMediaConnection: input.replaceMediaConnection }),
    });
    const bundled = await build({
      stdin: { contents: integratorBrowserSource({ api: config.api_url, slug: space.slug }), resolveDir: root, sourcefile: "integrator-browser.js" },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      logLevel: "silent",
    });
    server = createServer(integratorHandler({ session, origin: origin.origin, bundle: bundled.outputFiles[0].text }));
    server.requestTimeout = 30_000;
    server.listen(Number(origin.port), "127.0.0.1");
    await once(server, "listening");
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
