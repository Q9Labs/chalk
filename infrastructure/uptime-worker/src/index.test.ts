import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runMonitorCycle } from "./index.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const env = { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test/channel" };

test("checks the four service endpoints without alerting when healthy", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(null, { status: 200 });
  };
  assert.deepEqual(await runMonitorCycle(env), { checked: 4, failed: 0 });
  assert.deepEqual(urls.sort(), ["https://api.chalkmeet.com/healthz", "https://api.chalkmeet.com/readyz", "https://sync.chalkmeet.com/healthz", "https://sync.chalkmeet.com/readyz"]);
});

test("reports an unavailable API directly to Discord without calling an ingest API", async () => {
  const messages: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === env.DISCORD_WEBHOOK_URL) {
      messages.push(String(init?.body));
      return new Response(null, { status: 204 });
    }
    if (url.startsWith("https://api.chalkmeet.com/")) throw new Error("offline");
    return new Response(null, { status: 200 });
  };
  assert.deepEqual(await runMonitorCycle(env), { checked: 4, failed: 2 });
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /API readiness: unreachable/);
  assert.doesNotMatch(messages[0]!, /webhooks\/test\/channel/);
});

test("fails when alert delivery is rejected or the shared secret is missing", async () => {
  await assert.rejects(runMonitorCycle({}), /DISCORD_WEBHOOK_URL/);
  globalThis.fetch = async (input) => new Response(null, { status: String(input) === env.DISCORD_WEBHOOK_URL ? 429 : 503 });
  await assert.rejects(runMonitorCycle(env), /Discord alert delivery failed/);
});
