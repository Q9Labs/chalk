// Stands in for the browser, API and cloud modules that latency.mjs imports, so the test can run the real entry point through a
// whole cycle and let it write its files. The fake page runs each evaluate callback in this process against a fake `window`.
import { appendFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";

export { ProofError, check, errorEvidence, publicFailure, save } from "./runtime.mjs";

// The settle pauses between actions are 1.5 s each; here they take no time.
timers.setTimeout = async () => undefined;
syncBuiltinESMExports();

const armed = new Map();
let acted = 0;
let packets = 0;
globalThis.window = globalThis;
globalThis.proofLatency = {
  async arm(id, specs) {
    armed.set(id, specs);
  },
  async act() {
    acted = performance.timeOrigin + performance.now();
    return { at: acted, leaveAckAt: acted + 30 };
  },
  async result(id) {
    return armed.get(id).map(({ name }) => ({ name, at: acted + 50 }));
  },
};
// Each audio read is a window later: 100 packets, 2 s of jitter buffer over them, and 50 ms of playout over 4800 samples.
globalThis.proofTrace = {
  // A guest that connected 10 ms after the call, over a host to server-reflexive pair that sent 6 checks and got 4 replies.
  take: (from) => [
    { t: from + 10, k: "ice_connected", peer: 1 },
    { t: from + 11, k: "ice_pair", d: JSON.stringify({ peer: 1, readAfterMs: 400, local: process.env.FAKE_ICE_LOCAL ?? "host", remote: "srflx", protocol: "udp", requestsSent: 6, responsesReceived: 4 }) },
  ],
  readIce: async () => undefined,
  sfuRtt: async () => 40,
  async audioStats() {
    packets += 100;
    return { emitted: packets, jitterBufferDelay: packets * 0.02, samples: packets * 48, playoutDelay: packets * 48 * 0.05, playoutReported: true };
  },
};

const share = { goto: async () => undefined, close: async () => undefined };
const context = { newPage: async () => share, browser: () => ({ version: () => "151.0" }) };
const page = { context: () => context, bringToFront: async () => undefined, evaluate: async (callback, argument) => callback(argument) };

export const loadConfig = async () => ({});
export const command = async () => "a".repeat(40);
export const createRun = async (_config, directory, _signal, runId) => ({ runId, directory, tenantPath: "/v1/tenants/t", config: { api_url: "https://api.invalid" }, resources: [], apiRequest: async () => ({ id: "episode" }) });
export const sweepStaleRuns = async () => undefined;
export const cleanupRun = async () => undefined;
export const disposeResource = async () => [];
export const runLabel = () => undefined;
export const prepareIntegration = async () => ({ origin: "https://app.invalid" });
export const createSpace = async () => ({ id: "space", slug: "space" });
export const trackEpisode = async (run, space, episode) => {
  await appendFile(`${run.directory}/tracked.jsonl`, `${JSON.stringify({ space_id: space.id, id: episode.id })}\n`);
};
export const postEpisode = async () => ({ episode: { id: "episode" }, path: "/v1/tenants/t/spaces/space/episodes/episode" });
export const episodeEnd = () => ({ useSDK: () => undefined, end: async () => undefined });
export const launchGuests = async () => ({
  pages: [page, page],
  participants: ["guest-1", "guest-2"],
  admissions: [
    { provider: "chalk_sfu", ms: 5 },
    { provider: "chalk_sfu", ms: 5 },
  ],
});
export const installLatencyProbe = () => undefined;
