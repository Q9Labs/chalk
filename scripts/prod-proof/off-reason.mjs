import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// The SDK's own socket adapter does the work; this subclass only copies what the SDK later decodes.
function wire(sdk) {
  const seen = { welcome: undefined, media: [], closes: 0 };
  class TappedWebSocket extends WebSocket {
    constructor(url) {
      super(url);
      this.addEventListener("close", () => seen.closes++);
      this.addEventListener("message", (event) => tap(seen, JSON.parse(String(event.data))));
    }
  }
  return { seen, webSocket: sdk.createBrowserWebSocketFactory(TappedWebSocket) };
}

function tap(seen, frame) {
  if (frame.type === "welcome") seen.welcome = Object.fromEntries(Object.entries(frame).filter(([name]) => name === "media_off_reason"));
  else if (frame.stream === "media") seen.media.push(frame);
}

const idleLifecycle = {
  subscribe(listener) {
    listener("online");
    return () => {};
  },
};

async function connect(run, clients, sdk, url, token) {
  const { seen, webSocket } = wire(sdk);
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

function decodedCameraItem(client, participantId) {
  return client.getSnapshot().media?.items.find((item) => item.participantId === participantId && item.source === "camera");
}

// Wire frames show what Sync sent; the decoded item shows what the SDK kept of it.
async function sample(run, { client, seen }, guestId, label) {
  const wire = await itemWithin(run, `${label} on the wire`, async () => cameraItem(seen, guestId));
  const decoded = await itemWithin(run, `${label} in the SDK state`, async () => decodedCameraItem(client, guestId));
  return { wire, decoded, live: client.getSnapshot().connection.phase === "live", unexpectedCloses: seen.closes };
}

async function observe(run, clients, sdk, url, host, guest) {
  const first = await connect(run, clients, sdk, url, guest.token);
  const welcome = first.seen.welcome;
  const negotiated = first.client.offReasonNegotiated?.();
  check(cameraItem(first.seen, guest.id) === undefined, "Guest camera already had an item before the host stop");
  const { outcome: stopOutcome } = await host.client.stopParticipantCamera(guest.id);
  const stopped = await sample(run, first, guest.id, "host stop");
  first.client.stop();
  const second = await connect(run, clients, sdk, url, guest.token);
  const reopened = await sample(run, second, guest.id, "camera item after reopen");
  second.client.stop();
  return { welcome, negotiated, stopOutcome, stopped, reopened };
}

export async function offReasonProof(run) {
  const candidateSdk = await loadSdk(run, "candidate", resolve(process.env.CHALK_PROOF_CANDIDATE_SDK_ENTRY ?? new URL("../../sdks/typescript/client/src/index.ts", import.meta.url).pathname));
  const baselineSdk = await loadSdk(run, "baseline", await baselineEntry(run));
  await prepareIntegration(run, false);
  const space = await createSpace(run);
  const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: run.runId } });
  const path = `${run.tenantPath}/spaces/${space.id}/episodes/${episode.id}`;
  const ending = episodeEnd(run, path);
  const { defaultSyncUrl } = await loadSdk(run, "urls", fileURLToPath(new URL("../../sdks/typescript/client/src/space-client/core.ts", import.meta.url)));
  const url = defaultSyncUrl(run.config.api_url);
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
