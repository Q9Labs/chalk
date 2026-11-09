import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { verifyWebDeploy } from "./verify-web-deploy.mjs";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const APP = "https://app.example.test";
const API = "https://api.example.test";
const PAGES_ENVIRONMENT = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token", PAGES_PROJECT: "project" };

// A fake clock: sleeping moves time forward, so the test never waits for real.
function fakeClock() {
  let current = 1_000_000;
  const sleeps = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
  };
}

const json = (body, status = 200, contentType = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } });

// The served sw.js shows the old commit until `staleAttempts` requests for it have been answered.
function fakeNetwork({ staleAttempts, pagesCommit = NEW_SHA }) {
  const requests = [];
  let serviceWorkerRequests = 0;
  mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    requests.push({ url, headers: init?.headers ?? {} });
    if (url.hostname === "api.cloudflare.com") return json({ result: { canonical_deployment: { id: "dep-1", deployment_trigger: { metadata: { commit_hash: pagesCommit } } } } });
    if (url.pathname === "/healthz") return json({ status: "ok" });
    if (url.pathname === "/sw.js") {
      serviceWorkerRequests += 1;
      return json(`self.__build = {"commitHash":"${serviceWorkerRequests > staleAttempts ? NEW_SHA : OLD_SHA}"}`, 200, "text/javascript");
    }
    if (url.pathname === "/release.json") return json({ environment: "production", commit: NEW_SHA });
    if (url.pathname.startsWith("/.well-known/")) return json({});
    if (url.pathname === "/space/") return json('<meta name="apple-itunes-app" content="app-id=1">', 200, "text/html");
    return json("not found", 404);
  });
  return requests;
}

const verify = (clock, options = {}) => verifyWebDeploy({ baseURL: APP, apiBaseURL: API, expectedSHA: NEW_SHA, expectedEnvironment: "production", environment: PAGES_ENVIRONMENT, now: clock.now, sleep: clock.sleep, ...options });

let logs;
beforeEach(() => {
  logs = [];
  mock.method(console, "log", (line) => logs.push(line));
  mock.method(console, "warn", () => {});
});
afterEach(() => mock.restoreAll());

test("a stale service worker is retried with growing delays until the new commit shows, then the propagation time is logged", async () => {
  const clock = fakeClock();
  const requests = fakeNetwork({ staleAttempts: 3 });

  await verify(clock);

  assert.deepEqual(clock.sleeps, [2_000, 4_000, 8_000]);
  assert.ok(logs.includes("web propagation: 14 s, attempts 4"), logs.join("\n"));
  const serviceWorkerURLs = requests.filter(({ url }) => url.pathname === "/sw.js").map(({ url }) => url.search);
  assert.equal(new Set(serviceWorkerURLs).size, 4, "every sw.js fetch needs its own query string");
  assert.ok(requests.filter(({ url }) => url.hostname === "app.example.test").every(({ headers }) => headers["Cache-Control"] === "no-cache"));
});

test("a deployment that never shows up fails after the bound with the commits, attempts and elapsed time", async () => {
  const clock = fakeClock();
  fakeNetwork({ staleAttempts: Number.POSITIVE_INFINITY, pagesCommit: OLD_SHA });

  await assert.rejects(verify(clock, { deadlineMs: 300_000 }), (error) => {
    assert.match(error.message, new RegExp(`expected commit ${NEW_SHA}, last seen ${OLD_SHA}`));
    assert.match(error.message, /after 14 attempts in 300 s/);
    assert.match(error.message, /new deployment is not live at Pages yet/);
    return true;
  });
  assert.deepEqual(clock.sleeps.slice(0, 6), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.equal(
    clock.sleeps.reduce((total, milliseconds) => total + milliseconds, 0),
    300_000,
  );
});

test("a stale alias that Pages reports as live is named as such", async () => {
  const clock = fakeClock();
  fakeNetwork({ staleAttempts: Number.POSITIVE_INFINITY, pagesCommit: NEW_SHA });

  await assert.rejects(verify(clock, { deadlineMs: 10_000 }), /Pages has the new deployment live and the alias serves stale content/);
});
