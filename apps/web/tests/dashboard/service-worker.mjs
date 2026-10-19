import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Execute the built service worker at its browser API boundary, including the
// offline path. Cache API deliberately does not honor HTTP no-store by itself.
const source = await readFile(process.env.DASHBOARD_TEST_SW_PATH ?? resolve(import.meta.dirname, "../../dist/client/sw.js"), "utf8");
const handlers = new Map();
const stored = new Map();
let offline = false;
runInNewContext(source, {
  self: { location: { origin: "https://chalkmeet.com" }, addEventListener: (name, handler) => handlers.set(name, handler) },
  caches: { open: async () => ({ match: async (request) => stored.get(request.url), put: async (request, response) => stored.set(request.url, response) }) },
  fetch: async () => {
    if (offline) throw new Error("offline");
    return new Response("private-response-sentinel", { headers: { "Cache-Control": "private, no-store" } });
  },
  Response,
  URL,
});
for (const path of ["/auth/session", "/auth/callback?code=private", "/dashboard-api/home", "/dashboard-api/past-session", "/dashboard", "/dashboard/call"]) {
  for (const unavailable of [false, true]) {
    offline = unavailable;
    let intercepted = false;
    handlers.get("fetch")({
      request: new Request(`https://chalkmeet.com${path}`),
      respondWith: () => {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false, `${path} must bypass the service worker online and offline`);
  }
}
offline = false;
let response;
handlers.get("fetch")({
  request: new Request("https://chalkmeet.com/other-private-route"),
  respondWith: (pending) => {
    response = pending;
  },
});
assert.equal(await (await response).text(), "private-response-sentinel");
assert.equal(stored.size, 0, "no-store responses must never enter Cache API");
console.log("PASS: built service worker bypasses auth/dashboard online and offline and never caches no-store responses");
