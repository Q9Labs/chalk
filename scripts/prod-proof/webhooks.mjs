import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { shareHTML } from "./fixture.mjs";
import { check, save, waitFor } from "./runtime.mjs";

const { build } = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url))("esbuild");
export async function proofServer(run) {
  const origin = new URL(run.config.proof_origin);
  check(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname) && Number(origin.port) > 0, "proof_origin must be an HTTP loopback origin with an explicit port");
  const pages = { "/": "<!doctype html><title>Chalk production proof</title>", "/share": shareHTML };
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !Object.hasOwn(pages, request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" }).end(pages[request.url]);
  });
  server.listen(Number(origin.port), "127.0.0.1");
  await once(server, "listening");
  run.resources.push({
    kind: "proof-http-server",
    dispose: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  });
  return { origin: origin.origin, events: new Map() };
}
async function catcherRequest(base, path, method = "GET", body, signal) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  check(response.ok, `Webhook transport ${method} failed: HTTP ${response.status}`);
  return response;
}
function originalHeaders(values) {
  const headers = new Headers();
  for (const [name, entries] of Object.entries(values)) {
    check(Array.isArray(entries), "Webhook transport returned invalid headers");
    for (const value of entries) headers.append(name, value);
  }
  return headers;
}
async function collectEvents(run, receiver, token, endpoint, verifyWebhook, signal, seen) {
  const base = run.config.webhook_service_url;
  const response = await catcherRequest(base, `/token/${token.uuid}/requests?sorting=newest&per_page=50`, "GET", undefined, signal);
  const messages = (await response.json()).data;
  for (const message of messages) {
    if (seen.has(message.uuid)) continue;
    check(message.size <= 262_144, "Webhook exceeded body limit");
    const raw = await catcherRequest(base, `/token/${token.uuid}/request/${message.uuid}/raw`, "GET", undefined, signal);
    const event = await verifyWebhook({ rawBody: new Uint8Array(await raw.arrayBuffer()), headers: originalHeaders(message.headers), secrets: [endpoint.secret] });
    check(event.tenant_id === run.config.tenant_id, "Webhook Tenant does not match this run");
    receiver.events.set(event.id, event);
    seen.add(message.uuid);
  }
  await saveEvents(run, receiver);
}
function saveEvents(run, receiver) {
  return save(
    `${run.directory}/signed-webhooks.json`,
    [...receiver.events.values()].map((event) => ({ event: event.event, objectId: event.data.object.id, verified: true })),
  );
}
function startCollector(run, receiver, collect) {
  const controller = new AbortController();
  const completion = (async () => {
    try {
      while (!controller.signal.aborted) {
        await collect(controller.signal);
        await delay(2000, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) receiver.failure = error.message;
    }
  })();
  run.resources.push({
    kind: "webhook-collector",
    dispose: async () => {
      controller.abort();
      await completion;
    },
  });
}
export async function exposeWebhook(run, receiver) {
  check(run.config.webhook_service_url, "1Password item is missing webhook_service_url");
  const base = run.config.webhook_service_url;
  const token = await (await catcherRequest(base, "/token", "POST", { default_status: 204, request_limit: 50 }, run.signal)).json();
  run.resources.push({
    kind: "webhook-catcher",
    dispose: async () => {
      await catcherRequest(base, `/token/${token.uuid}`, "DELETE");
    },
  });
  const endpoint = await run.ownerRequest("POST", `${run.tenantPath}/webhook-endpoints`, {
    name: "Production proof",
    url: new URL(`/${token.uuid}`, base).href,
    enabled: true,
    api_version: 1,
    event_types: ["episode.started", "episode.ended", "recording.started", "recording.completed", "transcript.completed"],
  });
  run.resources.push({ kind: "webhook-endpoint", dispose: () => run.ownerRequest("DELETE", `${run.tenantPath}/webhook-endpoints/${endpoint.id}`, undefined, { "If-Match": `"${endpoint.revision}"` }) });
  const path = `${run.directory}/sdk-webhooks.mjs`;
  await build({ entryPoints: [new URL("../../sdks/typescript/client/src/webhooks/index.ts", import.meta.url).pathname], bundle: true, outfile: path, format: "esm", platform: "node" });
  const { verifyWebhook } = await import(pathToFileURL(path).href);
  const seen = new Set();
  startCollector(run, receiver, (signal) => collectEvents(run, receiver, token, endpoint, verifyWebhook, signal, seen));
}
export async function proveWebhookEvents(receiver, expected) {
  await waitFor(
    "signed lifecycle webhooks",
    () => {
      check(!receiver.failure, receiver.failure);
      return expected.every(({ event, objectId }) => [...receiver.events.values()].some((value) => value.event === event && value.data.object.id === objectId));
    },
    180_000,
  );
  return [...receiver.events.values()].map((event) => ({ event: event.event, objectId: event.data.object.id, verified: true }));
}
