import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createChalkServerClient, getAccessRefreshState } from "../../sdks/typescript/client/dist/server/index.js";
import { verifyWebhook } from "../../sdks/typescript/client/dist/webhooks/index.js";

const requireClient = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));
const requireHarness = createRequire(new URL("../../tools/sdk-web-consumer-e2e/package.json", import.meta.url));
const { chromium } = requireClient("playwright");
const { build } = requireHarness("esbuild");
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const apiKey = required("CHALK_API_KEY");
const tenantId = required("CHALK_TENANT_ID");
const webhookURL = required("CHALK_SMOKE_WEBHOOK_URL");
if (!webhookURL.startsWith("https://")) throw new Error("CHALK_SMOKE_WEBHOOK_URL must be a public HTTPS tunnel to this receiver's /webhook path");
const apiBaseURL = process.env.CHALK_API_URL || "https://api.chalkmeet.com";
const port = Number(process.env.CHALK_SMOKE_PORT || 9415);
const origin = `http://127.0.0.1:${port}`;
const boundedFetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
const bootstrap = createChalkServerClient({ apiKey, tenantId, apiBaseURL, fetch: boundedFetch });
const events = new Map();
const browsers = [];
let receiverFailure;
let signingSecret;
let smokeKey;
let chalk;
let endpoint;
let space;
let episode;
let ended = false;
let browserSource;

async function webhookRequest(method, path = "", body, revision) {
  const response = await fetch(`${apiBaseURL}/v1/tenants/${encodeURIComponent(tenantId)}/webhook-endpoints${path}`, {
    method,
    headers: {
      authorization: `Bearer ${smokeKey.secret}`,
      "content-type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": revision ? `"${revision}"` : "",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Webhook ${method} failed with HTTP ${response.status}`);
  if (response.status !== 204) return response.json();
}

function serveAsset(request, response) {
  const assets = new Map([
    ["GET /", { type: "text/html", body: '<!doctype html><title>Chalk integration smoke</title><script type="module" src="/client.js"></script>' }],
    ["GET /client.js", { type: "text/javascript", body: browserSource }],
  ]);
  const asset = assets.get(`${request.method} ${request.url}`);
  if (!asset?.body) return false;
  response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
  response.end(asset.body);
  return true;
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Webhook body exceeds 256 KiB");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function waitForSigningSecret() {
  // A delivery can race the endpoint-create response that reveals its one-time secret.
  const deadline = Date.now() + 5_000;
  while (!signingSecret && Date.now() < deadline) await delay(25);
  if (!signingSecret) throw new Error("Signing secret not available");
  return signingSecret;
}

function rememberEvent(event) {
  if (event.tenant_id !== tenantId) throw new Error("Webhook Tenant mismatch");
  if (event.data.object.space_id !== space?.id) return;
  events.set(event.id, event);
  console.info(`Verified ${event.event}`);
}

async function receive(request, response) {
  if (serveAsset(request, response)) return;
  if (`${request.method} ${request.url}` !== "POST /webhook") {
    response.writeHead(404).end();
    return;
  }
  const rawBody = await readRawBody(request);
  const secret = await waitForSigningSecret();
  const event = await verifyWebhook({ rawBody, headers: request.headers, secrets: [secret] });
  rememberEvent(event);
  response.writeHead(204).end();
}

const server = createServer((request, response) => {
  receive(request, response).catch((error) => {
    receiverFailure = error;
    if (!response.headersSent) response.writeHead(400);
    response.end();
  });
});
server.requestTimeout = 10_000;

function assertHealthyReceiver() {
  if (receiverFailure) throw receiverFailure;
  if ([...events.values()].some((event) => event.event.endsWith(".failed"))) throw new Error("Artifact pipeline reported failure");
}

async function until(description, predicate, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assertHealthyReceiver();
    const result = await predicate();
    if (result) return result;
    await delay(1_000);
  }
  throw new Error(`Timed out: ${description}`);
}

async function startReceiver() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.info(`Receiver ready at ${origin}; use a public HTTPS tunnel for /webhook`);
  const browserBundle = await build({
    stdin: {
      contents: `import { createSpaceClient } from ${JSON.stringify(fileURLToPath(new URL("../../sdks/typescript/client/dist/index.js", import.meta.url)))};
        window.smokeJoin = async (space, api, name) => {
          const client = createSpaceClient({ space, baseUrl: api, getAccess: ({reason}) => window.smokeAccess(reason) });
          window.smokeClient = client;
          await client.join({displayName: name, microphone: true, camera: true});
        };`,
      resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  browserSource = browserBundle.outputFiles[0].text;
}

async function provision() {
  smokeKey = await bootstrap.apiKeys.create({
    name: "Integration smoke",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: ["spaces:read", "spaces:write", "episodes:read", "episodes:write", "recordings:read", "recordings:write", "webhooks:read", "webhooks:write", "webhooks:delete"],
  });
  chalk = createChalkServerClient({ apiKey: smokeKey.secret, tenantId, apiBaseURL, fetch: boundedFetch });
  endpoint = await webhookRequest("POST", "", {
    name: "Integration smoke",
    url: webhookURL,
    enabled: true,
    api_version: 1,
    event_types: ["episode.started", "episode.ended", "recording.started", "recording.completed", "recording.failed"],
  });
  signingSecret = endpoint.secret;
  space = await chalk.spaces.create({
    name: "Integration smoke",
    slug: `integration-smoke-${crypto.randomUUID()}`,
    mediaPlane: process.env.CHALK_SMOKE_MEDIA_PLANE || "cf_sfu",
    recordingPolicy: "automatic",
    transcriptionPolicy: "disabled",
    defaultEpisodeDurationSeconds: 900,
    maximumEpisodeDurationSeconds: 900,
    lingerWindowSeconds: 60,
  });
  episode = await chalk.episodes.create(space.id, {});
}

async function joinParticipants() {
  const pages = [];
  for (const name of ["Smoke One", "Smoke Two"]) {
    const admission = await chalk.participants.admit(space.id, episode.id, { name, role: "owner" });
    if (!admission.access) throw new Error("Admission returned no AccessGrant");
    let grant = admission.access;
    let firstAccess = true;
    let queue = Promise.resolve();
    const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    browsers.push(browser);
    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    const page = await context.newPage();
    await page.exposeFunction("smokeAccess", () => {
      const next = queue.then(async () => {
        if (firstAccess) {
          firstAccess = false;
          return grant;
        }
        grant = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(grant));
        return grant;
      });
      // Keep serialization usable after failure; the caller still receives next's error.
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    });
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.smokeJoin === "function");
    await Promise.race([
      page.evaluate(({ slug, api, name }) => window.smokeJoin(slug, api, name), { slug: space.slug, api: apiBaseURL, name }),
      delay(90_000, undefined, { ref: false }).then(() => {
        throw new Error("Participant join timed out");
      }),
    ]);
    pages.push(page);
  }
  await until(
    "two live Participants with remote media",
    async () => {
      for (const page of pages) {
        if (
          !(await page.evaluate(() => {
            const snapshot = window.smokeClient.getSnapshot();
            return snapshot.connection.status === "live" && snapshot.participants.roster.length === 2 && snapshot.media.remote.some(({ track }) => track.readyState === "live");
          }))
        )
          return false;
      }
      return true;
    },
    90_000,
  );
}

async function recordAndExport() {
  const started = await until("recording.started", () => [...events.values()].find((event) => event.event === "recording.started"));
  console.info("Two browsers live; recording fake media for 60 seconds");
  await delay(60_000);
  await chalk.episodes.end(space.id, episode.id);
  ended = true;
  const recordingId = started.data.object.id;
  await until("Recording source available", async () => (await chalk.recordings.get(recordingId)).source.status === "available");
  await chalk.recordings.requestExport(recordingId);
  await until("recording.completed", () => [...events.values()].find((event) => event.event === "recording.completed" && event.data.object.id === recordingId));
  for (const name of ["episode.started", "episode.ended"]) {
    await until(name, () => [...events.values()].find((event) => event.event === name && event.data.object.id === episode.id));
  }
  return recordingId;
}

function assertMP4(bytes) {
  if (!bytes) throw new Error("MP4 download returned no bytes");
  if (Buffer.from(bytes).indexOf("ftyp") < 0) throw new Error("Download is not an MP4");
}

async function readDownloadPrefix(body) {
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < 64) {
      const { done, value } = await reader.read();
      if (done) break;
      const prefix = value.subarray(0, 64 - length);
      chunks.push(prefix);
      length += prefix.length;
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

async function verifyDownload(recordingId) {
  const download = await chalk.recordings.createDownloadURL(recordingId, { download: false, expiresInSeconds: 60 });
  const response = await fetch(download.url, { headers: { ...download.signed_headers, Range: "bytes=0-63" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error(`MP4 download failed: HTTP ${response.status}`);
  assertMP4(await readDownloadPrefix(response.body));
  console.info("PASS: two Participants, one-minute Recording, signed Episode/Recording Events, downloadable MP4");
}

async function run() {
  await startReceiver();
  await provision();
  await joinParticipants();
  const recordingId = await recordAndExport();
  await verifyDownload(recordingId);
}

let failed = false;
try {
  await run();
} catch (error) {
  failed = true;
  console.error(`BLOCKED: ${error instanceof Error ? error.message : "Integration smoke failed"}`);
} finally {
  const cleanupErrors = [];
  const cleanup = async (label, operation) => {
    try {
      await operation();
    } catch {
      cleanupErrors.push(label);
    }
  };
  if (episode && !ended) await cleanup("end Episode", () => chalk.episodes.end(space.id, episode.id));
  for (const browser of browsers) await cleanup("close browser", () => browser.close());
  if (endpoint) await cleanup("delete webhook endpoint", () => webhookRequest("DELETE", `/${endpoint.id}`, undefined, endpoint.revision));
  if (space) await cleanup("archive Space", () => chalk.spaces.archive(space.id));
  if (smokeKey) await cleanup("revoke smoke key", () => bootstrap.apiKeys.revoke(smokeKey.api_key.id));
  await cleanup("close receiver", () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  if (cleanupErrors.length) {
    failed = true;
    console.error(`Cleanup failed: ${cleanupErrors.join(", ")}`);
  }
}
process.exitCode = failed ? 1 : 0;
