import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const brokerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDirectory = await mkdtemp(join(tmpdir(), "chalk-meeting-broker-e2e-"));
const workerOrigin = "http://127.0.0.1:8787";
const fakeAPIOrigin = "http://127.0.0.1:8790";
const appOrigin = "https://chalkmeet.com";
const brokerConfig = join(stateDirectory, "wrangler.toml");
const productionConfig = await readFile(join(brokerDirectory, "wrangler.toml"), "utf8");
await writeFile(brokerConfig, `${productionConfig.replace('main = "src/index.ts"', `main = "${join(brokerDirectory, "src/index.ts")}"`)}\n[[services]]\nbinding = "CHALK_API_SERVICE"\nservice = "chalk-meeting-broker-fake-api"\n`);

const fakeAPI = wranglerProcess(["--config", join(brokerDirectory, "test/wrangler.fake-api.toml"), "--local", "--ip", "127.0.0.1", "--port", "8790", "--persist-to", stateDirectory]);
let fakeOutput = capture(fakeAPI);
await waitFor(`${fakeAPIOrigin}/calls`);

const broker = wranglerProcess([
  "--config",
  brokerConfig,
  "--local",
  "--ip",
  "127.0.0.1",
  "--port",
  "8787",
  "--persist-to",
  stateDirectory,
  "--var",
  `CHALK_APP_ORIGIN:${appOrigin}`,
  "--var",
  "CHALK_API_KEY:local-api-key",
  "--var",
  "CHALK_TENANT_ID:test-tenant",
  "--var",
  "CHALK_ROOM_ID:test-room",
  "--var",
  "CHALK_MEETING_LIFETIME_SECONDS:3",
  "--var",
  "CHALK_API_URL:https://fake-api.internal",
  "--var",
  "CHALK_SYNC_URL:ws://127.0.0.1:8791/v3/sync",
]);
let brokerOutput = capture(broker);

try {
  await waitFor(`${workerOrigin}/local-chalk/health`);
  const host = await post("/local-chalk/browser-session", { displayName: "Ada" });
  assert.equal(host.response.status, 201);
  assert.match(host.cookie, /^__Secure-chalk_session=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);
  assert.match(host.body.inviteToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await apiCalls()).length, 0, "browser session creation must not create Chalk resources");

  const hostAccess = await post("/local-chalk/access", {}, host.cookie);
  assert.equal(hostAccess.response.status, 201);
  assert.equal(hostAccess.body.subject.participantSessionId.length > 0, true);
  let calls = await apiCalls();
  assert.deepEqual(
    calls.map((call) => call.path.split("/").at(-1)),
    ["sessions", "participants"],
  );
  assert.equal(calls[0].body.maximum_duration_seconds <= 3_600, true);
  assert.equal(calls[1].body.initial_role, "host");
  assert.equal(
    calls.every((call) => call.authorization === "Bearer local-api-key"),
    true,
  );

  const resumedHost = await post("/local-chalk/browser-session", { displayName: "Ada", inviteToken: host.body.inviteToken }, host.cookie);
  assert.equal(resumedHost.response.status, 201);
  assert.equal(resumedHost.cookie, host.cookie);
  assert.equal((await post("/local-chalk/access", {}, resumedHost.cookie)).response.status, 201);
  calls = await apiCalls();
  assert.equal(calls.filter((call) => call.path.endsWith("/participants")).length, 1, "host resume must not admit a replacement participant");

  const refreshed = await post("/local-chalk/access", { currentMediaToken: "media-token", replaceMediaConnection: false }, host.cookie);
  assert.equal(refreshed.response.status, 201);
  calls = await apiCalls();
  assert.equal(calls.at(-1).path.endsWith("/access"), true);

  const guest = await post("/local-chalk/browser-session", { displayName: "Grace", inviteToken: host.body.inviteToken });
  assert.equal(guest.response.status, 201);
  assert.notEqual(guest.cookie, host.cookie);
  const guestAccess = await post("/local-chalk/access", {}, guest.cookie);
  assert.equal(guestAccess.response.status, 201);
  calls = await apiCalls();
  assert.equal(calls.at(-1).body.initial_role, "participant");
  assert.deepEqual(calls.at(-1).body.eligible_roles, ["host", "cohost", "participant"]);

  assert.equal((await post("/local-chalk/cleanup", {}, guest.cookie)).response.status, 204);
  calls = await apiCalls();
  assert.equal(calls.at(-1).path.endsWith("/remove"), true);
  assert.equal(calls.at(-1).body.participant_session_generation, 1);
  assert.equal((await post("/local-chalk/access", {}, guest.cookie)).response.status, 401);
  assert.equal((await post("/local-chalk/cleanup", {}, host.cookie)).response.status, 204);
  calls = await apiCalls();
  assert.equal(calls.at(-1).path.endsWith("/end"), true);

  const alarmHost = await post("/local-chalk/browser-session", { displayName: "Alarm Host" });
  assert.equal((await post("/local-chalk/access", {}, alarmHost.cookie)).response.status, 201);
  await waitForAccessUnauthorized(alarmHost.cookie);
  assert.equal((await post("/local-chalk/access", {}, alarmHost.cookie)).response.status, 401);

  calls = await apiCalls();
  console.log(JSON.stringify({ alarmTerminalCleanup: "verified", calls: calls.length, durableObject: "verified", hostCleanup: "verified", hostResume: "verified", inviteJoin: "verified", status: "ok" }));
} catch (error) {
  process.stderr.write(`${fakeOutput()}\n${brokerOutput()}`);
  throw error;
} finally {
  await Promise.all([stop(broker), stop(fakeAPI)]);
  await rm(stateDirectory, { force: true, recursive: true });
}

function wranglerProcess(arguments_) {
  return spawn("pnpm", ["exec", "wrangler", "dev", ...arguments_], { cwd: brokerDirectory, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
}

function capture(process) {
  let output = "";
  process.stdout.on("data", (chunk) => (output += chunk));
  process.stderr.on("data", (chunk) => (output += chunk));
  return () => output;
}

async function waitFor(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler did not make ${url} healthy within 30 seconds`);
}

async function post(path, body, cookie) {
  const response = await fetch(`${workerOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return { response, cookie: setCookie, body: response.status === 204 ? undefined : await response.json() };
}

async function apiCalls() {
  return fetch(`${fakeAPIOrigin}/calls`).then((response) => response.json());
}

async function waitForAccessUnauthorized(cookie) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await post("/local-chalk/access", {}, cookie)).response.status === 401) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The Durable Object alarm did not clear the meeting within 10 seconds");
}

async function stop(process) {
  process.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}
