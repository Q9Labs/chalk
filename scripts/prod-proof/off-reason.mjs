import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { baselineEntry } from "./leave.mjs";
import { evaluateOffReason } from "./off-reason-criteria.mjs";
import { createSpace, episodeEnd, prepareIntegration } from "./proofs.mjs";
import { check, save, waitFor } from "./runtime.mjs";

const requireSDK = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));

async function loadSdk(run, name, entry) {
  const outfile = `${run.directory}/off-reason-${name}.mjs`;
  await requireSDK("esbuild").build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", nodePaths: [new URL("../../sdks/typescript/client/node_modules", import.meta.url).pathname], logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}

function syncUrl(apiUrl) {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.hostname.startsWith("api.")) url.hostname = `sync.${url.hostname.slice(4)}`;
  else if (url.hostname.endsWith(".chalkmeet.com")) url.hostname = url.hostname.replace(/^([^.]+-)api\./u, "$1sync.");
  url.pathname = "/v1/sync";
  return url.toString();
}

// A Node WebSocket factory that also keeps the wire view the SDK hides: the welcome frame and the media items.
function wire() {
  const seen = { welcome: undefined, media: [], closes: 0 };
  const webSocket = {
    connect(url) {
      const socket = new WebSocket(url);
      const adapter = {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
      };
      socket.addEventListener("open", () => adapter.onopen?.());
      socket.addEventListener("error", () => adapter.onerror?.());
      socket.addEventListener("close", (event) => {
        seen.closes++;
        adapter.onclose?.({ code: event.code, reason: event.reason, wasClean: event.wasClean });
      });
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "welcome") seen.welcome = "media_off_reason" in frame ? { media_off_reason: frame.media_off_reason } : {};
        if (frame.stream === "media") seen.media.push(frame);
        adapter.onmessage?.({ data: event.data });
      });
      return adapter;
    },
  };
  return { seen, webSocket };
}

const idleLifecycle = {
  subscribe(listener) {
    listener("online");
    return () => {};
  },
};

async function connect(run, clients, sdk, url, token) {
  const { seen, webSocket } = wire();
  const client = sdk.createV1SyncClient({ url, token: async () => token, webSocket, lifecycle: idleLifecycle, page: null });
  clients.push(client);
  await client.start();
  await waitFor("Sync connection live", async () => client.getSnapshot().connection.phase === "live", 30_000, 200, run.signal);
  return { client, seen };
}

// An item that never arrives is a failed check, not a crash, so the other socket is still observed.
async function itemWithin(run, label, probe) {
  try {
    return await waitFor(label, probe, 10_000, 200, run.signal);
  } catch (error) {
    if (error.reason === "timeout") return undefined;
    throw error;
  }
}

function cameraItem(seen, participantId) {
  const items = seen.media.flatMap((frame) => frame.items ?? [frame.item]);
  return items.findLast((item) => item?.participant_id === participantId && item.source === "camera");
}

async function admit(run, path, name, role) {
  const admission = await run.apiRequest("POST", `${path}/participants`, { name, role });
  return { id: admission.participant.id, token: admission.access.sync.token };
}

async function observe(run, clients, sdk, url, host, guest) {
  const first = await connect(run, clients, sdk, url, guest.token);
  const welcome = first.seen.welcome;
  const negotiated = first.client.offReasonNegotiated?.();
  check(cameraItem(first.seen, guest.id) === undefined, "Guest camera already had an item before the host stop");
  const { outcome: stopOutcome } = await host.client.stopParticipantCamera(guest.id);
  const stopped = await itemWithin(run, "host stop on the guest socket", async () => cameraItem(first.seen, guest.id));
  const live = first.client.getSnapshot().connection.phase === "live";
  const unexpectedCloses = first.seen.closes;
  first.client.stop();
  const second = await connect(run, clients, sdk, url, guest.token);
  const reopened = await itemWithin(run, "camera item in the reopened snapshot", async () => cameraItem(second.seen, guest.id));
  const reopenedUnexpectedCloses = second.seen.closes;
  second.client.stop();
  return { welcome, negotiated, stopOutcome, live, unexpectedCloses, stopped, reopened, reopenedUnexpectedCloses };
}

export async function offReasonProof(run) {
  const candidateSdk = await loadSdk(run, "candidate", resolve(process.env.CHALK_PROOF_CANDIDATE_SDK_ENTRY ?? new URL("../../sdks/typescript/client/src/index.ts", import.meta.url).pathname));
  const baselineSdk = await loadSdk(run, "baseline", await baselineEntry(run));
  await prepareIntegration(run, false);
  const space = await createSpace(run);
  const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: run.runId } });
  const path = `${run.tenantPath}/spaces/${space.id}/episodes/${episode.id}`;
  const ending = episodeEnd(run, path);
  const url = syncUrl(run.config.api_url);
  const clients = [];
  try {
    const hostAccess = await admit(run, path, "Proof host", "owner");
    const candidateGuest = await admit(run, path, "Proof candidate guest", "collaborator");
    const baselineGuest = await admit(run, path, "Proof baseline guest", "collaborator");
    const host = await connect(run, clients, candidateSdk, url, hostAccess.token);
    const candidate = await observe(run, clients, candidateSdk, url, host, candidateGuest);
    const baseline = await observe(run, clients, baselineSdk, url, host, baselineGuest);
    const result = { ...evaluateOffReason({ candidate, baseline }), candidate, baseline, baselineSdk: "5.2.6", candidateSdk: process.env.CHALK_PROOF_CANDIDATE_SDK_ENTRY ? "override" : "checkout" };
    await save(`${run.directory}/off-reason.json`, result);
    console.log(
      `Off-reason checks: ${Object.entries(result.checks)
        .map(([name, passed]) => `${name}=${passed}`)
        .join(" ")}`,
    );
    check(result.passed, "Off-reason proof failed");
    return result;
  } finally {
    for (const client of clients) client.stop();
    await ending.end();
  }
}
