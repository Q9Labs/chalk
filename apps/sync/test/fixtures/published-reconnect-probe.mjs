// Adapted from the round-2 judge's real published-package probe.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [version, port, token, marker] = process.argv.slice(2);
const sdk = version === 'head'
  ? await import('../../../../../sdks/typescript/client/src/sync/v1-client.ts')
  : await import(pathToFileURL(`${process.env.CHALK_PRESENCE_PUBLISHED_ROOT}/${version}/package/dist/sync/index.js`).href);
const { createBrowserWebSocketFactory } = version === 'head'
  ? await import('../../../../../sdks/typescript/client/src/sync/browser.ts') : sdk;
let listener;
let connections = 0;
const welcomes = [];
class ObservedWebSocket extends WebSocket {
  constructor(url) {
    super(url);
    connections++;
    this.addEventListener('message', ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.type === 'welcome') welcomes.push({ mode: frame.mode, reason: frame.reason ?? null });
    });
  }
}
const client = new sdk.V1SyncClient({
  url: `ws://127.0.0.1:${port}/v1/sync`, token: async () => token,
  webSocket: createBrowserWebSocketFactory(ObservedWebSocket), reconnectDelayMs: 100,
  lifecycle: { subscribe(fn) { listener = fn; return () => {}; } },
  ...(version === 'head' ? { collaboration: { name: 'collaboration_v2', chatCursor: { afterSequence: null, retainedFloorSequence: null } } } : {}),
});
const until = async (condition) => {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('real-client probe timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
try {
  await client.start();
  await until(() => client.getSnapshot().connection.phase === 'live');
  listener('offline');
  writeFileSync(`${marker}.ready`, 'offline');
  await until(() => existsSync(`${marker}.expired`));
  listener('online');
  await until(() => client.getSnapshot().connection.phase === 'live');
  assert.equal(welcomes.filter(w => w.mode === 'terminal').length, 0);
  listener('offline');
  writeFileSync(`${marker}.recovered`, 'same-token-live');
  await until(() => existsSync(`${marker}.ended`));
  listener('online');
  await until(() => welcomes.some(w => w.mode === 'terminal' && w.reason === 'episode_ended'));
  await until(() => client.getSnapshot().connection.phase === 'terminal');
  console.log('SDK_RETURN_PROOF=' + JSON.stringify({ version, connections, welcomes, recoveredBeforeEnd: true, finalPhase: client.getSnapshot().connection.phase }));
} finally {
  client.stop();
}
