// Adapted from the round-2 judge's real published-package probe.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [version, port, token, marker] = process.argv.slice(2);
const sdk = version === "head" ? await import("../../../../sdks/typescript/client/src/sync/v1-client.ts") : await import(pathToFileURL(`${process.env.CHALK_PRESENCE_PUBLISHED_ROOT}/${version}/package/dist/sync/index.js`).href);
const { createBrowserWebSocketFactory } = version === "head" ? await import("../../../../sdks/typescript/client/src/sync/browser.ts") : sdk;
let listener;
let connections = 0;
const welcomes = [];
const closes = [];
let completedRecoveries = 0;
class ObservedWebSocket extends WebSocket {
  constructor(url) {
    super(url);
    connections++;
    this.addEventListener("message", ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.type === "welcome") welcomes.push({ mode: frame.mode, reason: frame.reason ?? null });
      if (frame.type === "recovery_complete") completedRecoveries++;
    });
    this.addEventListener("close", (event) => closes.push({ code: event.code, reason: event.reason }));
  }
}
const client = new sdk.V1SyncClient({
  url: `ws://127.0.0.1:${port}/v1/sync`,
  token: async () => token,
  webSocket: createBrowserWebSocketFactory(ObservedWebSocket),
  reconnectDelayMs: 100,
  lifecycle: {
    subscribe(fn) {
      listener = fn;
      return () => {};
    },
  },
  ...(version === "head" ? { collaboration: { name: "collaboration_v2", chatCursor: { afterSequence: null, retainedFloorSequence: null } } } : {}),
});
const until = async (condition) => {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("real-client probe timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const drop = async () => {
  const closed = closes.length;
  listener("offline");
  await until(() => closes.length > closed);
};
try {
  await client.start();
  await until(() => client.getSnapshot().connection.phase === "live");
  await drop();
  writeFileSync(`${marker}.ready`, "offline");
  await until(() => existsSync(`${marker}.expired`));
  const previousRecoveries = completedRecoveries;
  listener("online");
  await until(() => completedRecoveries > previousRecoveries && client.getSnapshot().connection.phase === "live");
  const returnedConnections = connections;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(client.getSnapshot().connection.phase, "live");
  assert.equal(connections, returnedConnections, "the recovered client must stay connected");
  assert.equal(welcomes.filter((w) => w.mode === "terminal").length, 0);
  await drop();
  writeFileSync(`${marker}.recovered`, "same-token-live");
  await until(() => existsSync(`${marker}.ended`));
  listener("online");
  await until(() => welcomes.some((w) => w.mode === "terminal" && w.reason === "episode_ended"));
  await until(() => client.getSnapshot().connection.phase === "terminal");
  console.log("SDK_RETURN_PROOF=" + JSON.stringify({ version, connections, welcomes, recoveredBeforeEnd: true, completedRecoveries, closes, finalPhase: client.getSnapshot().connection.phase }));
} finally {
  client.stop();
}
