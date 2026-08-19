import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const brokerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDirectory = await mkdtemp(join(tmpdir(), "chalk-episode-broker-e2e-"));
const workerOrigin = "http://127.0.0.1:8787";
const fakeAPIOrigin = "http://127.0.0.1:8790";
const appOrigin = "https://chalkmeet.com";
const brokerConfig = join(stateDirectory, "wrangler.toml");
const productionConfig = await readFile(join(brokerDirectory, "wrangler.toml"), "utf8");
await writeFile(brokerConfig, `${productionConfig.replace('main = "src/index.ts"', `main = "${join(brokerDirectory, "src/index.ts")}"`)}\n[[services]]\nbinding = "CHALK_API_SERVICE"\nservice = "chalk-episode-broker-fake-api"\n`);

const fakeAPI = wranglerProcess(["--config", join(brokerDirectory, "test/wrangler.fake-api.toml"), "--local", "--ip", "127.0.0.1", "--port", "8790", "--persist-to", stateDirectory]);
const fakeOutput = capture(fakeAPI);
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
  "CHALK_SPACE_ID:test-space",
  "--var",
  "CHALK_EPISODE_DEADLINE_SECONDS:3",
  "--var",
  "CHALK_API_URL:https://fake-api.internal",
  "--var",
  "CHALK_SYNC_URL:ws://127.0.0.1:8791/v1/sync",
]);
const brokerOutput = capture(broker);

try {
  await waitFor(`${workerOrigin}/local-chalk/health`);
  const creator = await post("/local-chalk/participant-credentials", { displayName: "Ada" });
  assert.equal(creator.response.status, 201);
  assert.match(creator.cookie, /^__Secure-chalk_participant_credential=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);
  assert.match(creator.body.spaceInviteToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(Object.keys(creator.body).sort(), ["apiBaseURL", "spaceInviteToken", "syncURL"]);
  let calls = await apiCalls();
  assert.equal(calls.length, 1, "Credential creation must create one isolated Space");
  const creatorSpaceId = calls[0].spaceId;
  assert.match(creatorSpaceId, /^[0-9a-f-]{36}$/u);
  assert.equal(calls[0].body.default_episode_duration_seconds, 3);
  assert.equal(calls[0].body.maximum_episode_duration_seconds, 3);
  assert.match(calls[0].idempotencyKey, /^space-create-[0-9a-f-]{36}$/u);

  const creatorAccess = await post("/local-chalk/access-grants", {}, creator.cookie);
  assert.equal(creatorAccess.response.status, 201);
  assert.equal(creatorAccess.body.subject.participant_id.length > 0, true);
  calls = await apiCalls();
  assert.deepEqual(
    calls.map((call) => call.path.split("/").at(-1)),
    ["spaces", "episodes", "participants"],
  );
  assert.equal(calls[2].body.role, "owner");
  assert.equal(
    calls.slice(1).every((call) => call.path.includes(`/spaces/${creatorSpaceId}/`)),
    true,
  );
  assert.equal(
    calls.every((call) => call.authorization === "Bearer local-api-key"),
    true,
  );

  const resumedCreator = await post("/local-chalk/participant-credentials", { displayName: "Ada", spaceInviteToken: creator.body.spaceInviteToken }, creator.cookie);
  assert.equal(resumedCreator.response.status, 201);
  assert.equal(resumedCreator.cookie, creator.cookie);
  assert.equal((await post("/local-chalk/access-grants", {}, resumedCreator.cookie)).response.status, 201);
  calls = await apiCalls();
  assert.equal(calls.filter((call) => call.path.endsWith("/participants")).length, 1, "creator resume must not admit a replacement Participant");

  const refreshed = await post("/local-chalk/access-grants", { currentMediaToken: "media-token", replaceMediaConnection: false }, creator.cookie);
  assert.equal(refreshed.response.status, 201);
  calls = await apiCalls();
  assert.equal(calls.at(-1).path.endsWith("/access-grant"), true);

  const collaborator = await post("/local-chalk/participant-credentials", { displayName: "Grace", spaceInviteToken: creator.body.spaceInviteToken });
  assert.equal(collaborator.response.status, 201);
  assert.notEqual(collaborator.cookie, creator.cookie);
  const collaboratorAccess = await post("/local-chalk/access-grants", {}, collaborator.cookie);
  assert.equal(collaboratorAccess.response.status, 201);
  calls = await apiCalls();
  assert.equal(calls.at(-1).body.role, "collaborator");

  const nativeCollaborator = await nativePost("/local-chalk/participant-credentials", { displayName: "Lin", spaceInviteToken: creator.body.spaceInviteToken });
  assert.equal(nativeCollaborator.response.status, 201);
  assert.match(nativeCollaborator.body.participantCredentialId, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(nativeCollaborator.body.spaceInviteToken, creator.body.spaceInviteToken);
  const nativeAccess = await nativePost("/local-chalk/access-grants", {
    participantCredentialId: nativeCollaborator.body.participantCredentialId,
    spaceInviteToken: nativeCollaborator.body.spaceInviteToken,
    replaceMediaConnection: false,
  });
  assert.equal(nativeAccess.response.status, 201);
  assert.equal(nativeAccess.body.subject.participant_id.length > 0, true);
  assert.equal(
    (
      await nativePost("/local-chalk/participant-credentials/cleanup", {
        participantCredentialId: nativeCollaborator.body.participantCredentialId,
        spaceInviteToken: nativeCollaborator.body.spaceInviteToken,
      })
    ).response.status,
    204,
  );

  assert.equal((await post("/local-chalk/participant-credentials/cleanup", {}, collaborator.cookie)).response.status, 204);
  calls = await apiCalls();
  assert.equal(calls.at(-1).path.endsWith("/remove"), true);
  assert.equal(calls.at(-1).body.participant_generation, 1);
  assert.equal((await post("/local-chalk/access-grants", {}, collaborator.cookie)).response.status, 401);
  assert.equal((await post("/local-chalk/participant-credentials/cleanup", {}, creator.cookie)).response.status, 204);
  calls = await apiCalls();
  assert.equal(calls.at(-2).path.endsWith("/end"), true);
  assert.equal(calls.at(-1).path, `/v1/tenants/test-tenant/spaces/${creatorSpaceId}/archive`);

  const deadlineCreator = await post("/local-chalk/participant-credentials", { displayName: "Deadline Creator" });
  calls = await apiCalls();
  const deadlineSpaceId = calls.at(-1).spaceId;
  assert.notEqual(deadlineSpaceId, creatorSpaceId, "independent invites must use different Spaces");
  assert.equal((await post("/local-chalk/access-grants", {}, deadlineCreator.cookie)).response.status, 201);
  await waitForAccessUnauthorized(deadlineCreator.cookie);
  assert.equal((await post("/local-chalk/access-grants", {}, deadlineCreator.cookie)).response.status, 401);

  assert.equal((await fetch(`${fakeAPIOrigin}/fail-next-space-creation`, { method: "POST" })).status, 204);
  const failedCreator = await post("/local-chalk/participant-credentials", { displayName: "Retry Creator" });
  assert.equal(failedCreator.response.status, 503);
  calls = await apiCalls();
  const failedSpaceKey = calls.at(-1).idempotencyKey;
  await waitForSpaceArchive(failedSpaceKey);
  calls = await apiCalls();
  const recoveredSpaceCalls = calls.filter((call) => call.idempotencyKey === failedSpaceKey);
  assert.equal(recoveredSpaceCalls.length, 4, "cleanup must reuse the failed Space creation idempotency key");
  const recoveredSpaceId = recoveredSpaceCalls.at(-1).spaceId;
  assert.equal(
    calls.some((call) => call.path === `/v1/tenants/test-tenant/spaces/${recoveredSpaceId}/archive`),
    true,
  );

  calls = await apiCalls();
  console.log(
    JSON.stringify({
      calls: calls.length,
      creatorCleanup: "verified",
      creatorResume: "verified",
      durableObject: "verified",
      episodeDeadline: "verified",
      failedProvisionCleanup: "verified",
      isolatedSpaces: "verified",
      nativeParticipantCredential: "verified",
      spaceInviteJoin: "verified",
      status: "ok",
    }),
  );
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

async function nativePost(path, body) {
  const response = await fetch(`${workerOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: response.status === 204 ? undefined : await response.json() };
}

async function apiCalls() {
  return fetch(`${fakeAPIOrigin}/calls`).then((response) => response.json());
}

async function waitForAccessUnauthorized(cookie) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await post("/local-chalk/access-grants", {}, cookie)).response.status === 401) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The Episode lease alarm did not clear the credential within 10 seconds");
}

async function waitForSpaceArchive(idempotencyKey) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const calls = await apiCalls();
    const recoveredSpaceId = calls.findLast((call) => call.idempotencyKey === idempotencyKey && call.spaceId)?.spaceId;
    if (recoveredSpaceId && calls.some((call) => call.path === `/v1/tenants/test-tenant/spaces/${recoveredSpaceId}/archive`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The Episode lease alarm did not archive the recovered Space within 10 seconds");
}

async function stop(process) {
  process.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}
