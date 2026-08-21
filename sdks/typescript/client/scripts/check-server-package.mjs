import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const exec = promisify(execFile);
const packageDirectory = new URL("../", import.meta.url);
const packagePath = packageDirectory.pathname;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "chalk-server-package-"));
const archiveDirectory = join(temporaryDirectory, "archive");
const consumerDirectory = join(temporaryDirectory, "consumer");

try {
  await mkdir(archiveDirectory);
  await mkdir(consumerDirectory);
  await exec("pnpm", ["pack", "--pack-destination", archiveDirectory], { cwd: packagePath });
  const archiveName = (await readdir(archiveDirectory)).find((file) => file.endsWith(".tgz"));
  if (!archiveName) throw new Error("pnpm pack did not produce an archive.");

  await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({ name: "chalk-server-package-consumer", private: true, type: "module" }));
  const installedPackageDirectory = join(consumerDirectory, "node_modules", "@q9labsai", "chalk-client");
  await mkdir(installedPackageDirectory, { recursive: true });
  await exec("tar", ["-xzf", join(archiveDirectory, archiveName), "--strip-components=1", "-C", installedPackageDirectory]);
  await writeFile(join(consumerDirectory, "server-test.mjs"), serverTestSource());
  await writeFile(join(consumerDirectory, "server-test.cjs"), commonJsTestSource());
  await exec(process.execPath, ["server-test.mjs"], { cwd: consumerDirectory });
  await exec(process.execPath, ["server-test.cjs"], { cwd: consumerDirectory });

  await assertGuard("browser", "import", "esm");
  await assertGuard("browser", "require", "cjs");
  await assertGuard("react-native", "import", "esm");
  await assertGuard("react-native", "require", "cjs");
  await assertPublicInviteEntry();
  await assertWorkerd();

  const packageJson = JSON.parse(await readFile(new URL("package.json", packageDirectory), "utf8"));
  const forbiddenDependencies = ["express", "hono", "next"].filter((dependency) => dependency in (packageJson.dependencies ?? {}));
  if (forbiddenDependencies.length > 0) throw new Error(`Server client added framework dependencies: ${forbiddenDependencies.join(", ")}`);
  const rootBundle = await readFile(new URL("dist/index.js", packageDirectory), "utf8");
  if (rootBundle.includes("createChalkServerClient") || rootBundle.includes("chalk_sk_")) throw new Error("The browser package root contains server-client code.");
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function assertPublicInviteEntry() {
  const bundled = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ["browser", "import"],
    external: ["effect", "effect/unstable/httpapi", "effect/unstable/http"],
    format: "esm",
    platform: "browser",
    stdin: { contents: 'export { createChalkPublicClient } from "@q9labsai/chalk-client/invites";', resolveDir: consumerDirectory },
    write: false,
  });
  const output = bundled.outputFiles[0]?.text ?? "";
  if (!output.includes("createChalkPublicClient") || output.includes("createChalkServerClient") || output.includes("ChalkServerOnlyError")) {
    throw new Error("the browser public-invites entry includes server-only management code.");
  }
}

async function assertGuard(condition, syntax, format) {
  const contents = syntax === "import" ? 'import "@q9labsai/chalk-client/server";' : 'require("@q9labsai/chalk-client/server");';
  const bundled = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: [condition, syntax],
    format,
    platform: "neutral",
    stdin: { contents, resolveDir: consumerDirectory },
    write: false,
  });
  const output = bundled.outputFiles[0]?.text ?? "";
  if (!output.includes("ChalkServerOnlyError") || output.includes("createChalkServerClient")) throw new Error(`${condition} ${syntax} did not resolve to the server-only guard.`);

  try {
    if (format === "esm") await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    else Function(output)();
    throw new Error(`${condition} ${syntax} did not throw.`);
  } catch (error) {
    if (error?.name !== "ChalkServerOnlyError") throw error;
  }
}

async function assertWorkerd() {
  const bundled = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ["workerd", "import"],
    format: "esm",
    platform: "neutral",
    stdin: { contents: 'export { createChalkServerClient } from "@q9labsai/chalk-client/server";', resolveDir: consumerDirectory },
    write: false,
  });
  const output = bundled.outputFiles[0]?.text ?? "";
  if (!output.includes("createChalkServerClient") || output.includes("ChalkServerOnlyError")) throw new Error("workerd did not resolve to the server client.");
}

function serverTestSource() {
  return String.raw`
import assert from "node:assert/strict";
import { ChalkAPIError, createChalkServerClient } from "@q9labsai/chalk-client/server";

const apiKey = "chalk_sk_PACKED_SENTINEL.secret";
const tenantId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const participantId = "44444444-4444-4444-8444-444444444444";
const calls = [];
const queues = new Map();
const reply = (route, ...responses) => queues.set(route, responses);
const fetch = async (input, init) => {
  const url = String(input);
  const route = new URL(url).pathname;
  calls.push({ init, url });
  const response = queues.get(route)?.shift();
  if (response instanceof Error) throw response;
  if (!response) throw new Error("Unexpected route " + route);
  return response;
};
const json = (body, status) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const base = "/v1/tenants/" + tenantId;

reply(base + "/spaces", json({ id: spaceId }, 201));
const client = createChalkServerClient({ apiBaseURL: "https://api.example.test", apiKey, fetch, tenantId, headers: { authorization: "Bearer wrong", "x-safe": "safe" } });
assert.equal((await client.spaces.create({ defaultEpisodeDurationSeconds: 3600, lingerWindowSeconds: 120, maximumEpisodeDurationSeconds: 7200, mediaPlane: "cf_sfu", name: "Space", slug: "space" })).id, spaceId);
assert.equal(calls[0].url, "https://api.example.test" + base + "/spaces");
assert.deepEqual(JSON.parse(calls[0].init.body), { default_episode_duration_seconds: 3600, linger_window_seconds: 120, maximum_episode_duration_seconds: 7200, media_plane: "cf_sfu", name: "Space", slug: "space" });
assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer " + apiKey);

const episodeRoute = base + "/spaces/" + spaceId + "/episodes";
reply(episodeRoute, json({ error: { code: "busy" } }, 503), json({ error: { code: "busy" } }, 503), json({ id: episodeId }, 201));
await client.episodes.create(spaceId, { metadata: { source: "package" } }, { idempotencyKey: "stable-key" });
const episodeCalls = calls.filter(({ url }) => new URL(url).pathname === episodeRoute);
assert.equal(episodeCalls.length, 3);
assert.deepEqual(episodeCalls.map(({ init }) => new Headers(init.headers).get("idempotency-key")), ["stable-key", "stable-key", "stable-key"]);

const participantRoute = episodeRoute + "/" + episodeId + "/participants";
reply(participantRoute, json({ lifecycle_intent: { status: "applied" }, participant: { id: participantId } }, 201));
await client.participants.admit(spaceId, episodeId, { name: "Guest", participantId, role: "collaborator" }, { idempotencyKey: "admit-key" });
assert.deepEqual(JSON.parse(calls.at(-1).init.body), { name: "Guest", participant_id: participantId, role: "collaborator" });
assert.equal(new Headers(calls.at(-1).init.headers).get("idempotency-key"), "admit-key");

const endRoute = episodeRoute + "/" + episodeId + "/end";
reply(endRoute, json({ episode_id: episodeId, status: "ending", external_operation: { id: "operation" } }, 202));
await client.episodes.end(spaceId, episodeId, { idempotencyKey: "end-key" });
assert.equal(new Headers(calls.at(-1).init.headers).get("idempotency-key"), "end-key");

const listRoute = base + "/api-keys";
const listCallsBefore = calls.length;
reply(listRoute, new Error("offline"), json({ error: { code: "rate_limited" } }, 429), json({ api_keys: [], pagination: { has_more: false, next_cursor: null, page_size: 20 } }, 200));
assert.deepEqual((await client.apiKeys.list()).api_keys, []);
assert.equal(calls.length - listCallsBefore, 3);

const apiKeyId = "55555555-5555-4555-8555-555555555555";
reply(listRoute, json({ api_key: { id: apiKeyId }, secret: "one-time-secret" }, 201));
assert.equal((await client.apiKeys.create({ expiresAt: "2027-01-01T00:00:00Z", name: "backend", scopes: ["spaces:write"] })).secret, "one-time-secret");
assert.deepEqual(JSON.parse(calls.at(-1).init.body), { expires_at: "2027-01-01T00:00:00Z", name: "backend", scopes: ["spaces:write"] });

const failureCallsBefore = calls.length;
reply(listRoute, json({ error: { code: "service_unavailable", message: apiKey } }, 503));
let createFailure;
try {
  await client.apiKeys.create({ expiresAt: "2027-01-01T00:00:00Z", name: "backend", scopes: ["spaces:write"] });
} catch (error) {
  createFailure = error;
}
assert(createFailure instanceof ChalkAPIError);
assert.equal(calls.length - failureCallsBefore, 1);
assert.equal(JSON.stringify(createFailure).includes(apiKey), false);
assert.equal("cause" in createFailure, false);

const rotateRoute = listRoute + "/" + apiKeyId + "/rotate";
reply(rotateRoute, json({ api_key: { id: apiKeyId }, secret: "rotated-secret" }, 200));
assert.equal((await client.apiKeys.rotate(apiKeyId, { expiresAt: "2027-02-01T00:00:00Z" })).secret, "rotated-secret");
assert.deepEqual(JSON.parse(calls.at(-1).init.body), { expires_at: "2027-02-01T00:00:00Z" });

const revokeRoute = listRoute + "/" + apiKeyId;
reply(revokeRoute, json(null, 204));
await client.apiKeys.revoke(apiKeyId);
assert.equal(calls.at(-1).init.method, "DELETE");

const accessRoute = episodeRoute + "/" + episodeId + "/participants/" + participantId + "/access-grant";
reply(accessRoute, json({ error: { code: "busy" } }, 503), json({
  subject: { tenant_id: tenantId, space_id: spaceId, episode_id: episodeId, participant_id: participantId, participant_generation: 2 },
  sync: { token: accessToken("chalk-sync"), expires_at: "2026-01-01T00:05:00Z" },
  media: { token: accessToken("chalk-media"), expires_at: "2026-01-01T00:05:00Z", provider: "cloudflare_sfu", client_payload: { connectionId: "connection", stunServer: "stun:example.test" } }
}, 201));
const access = await client.participants.issueAccess(spaceId, episodeId, participantId, { participantGeneration: 2, currentMediaToken: "old-media" });
assert.equal(typeof access, "object");
const accessBody = JSON.parse(calls.at(-1).init.body);
assert.deepEqual(accessBody, { current_media_token: "old-media", participant_generation: 2, replace_media_connection: false });

for (const { init, url } of calls) {
  assert.equal(url.includes(apiKey), false);
  assert.equal(String(init.body ?? "").includes(apiKey), false);
  const secretHeaders = [...new Headers(init.headers)].filter(([, value]) => value.includes(apiKey));
  assert.deepEqual(secretHeaders, [["authorization", "Bearer " + apiKey]]);
}

function accessToken(audience) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return encode({ alg: "EdDSA", typ: "JWT" }) + "." + encode({ aud: audience }) + ".signature";
}
`;
}

function commonJsTestSource() {
  return String.raw`
const assert = require("node:assert/strict");
const server = require("@q9labsai/chalk-client/server");
assert.equal(typeof server.createChalkServerClient, "function");
assert.equal(server.ChalkAPIError.prototype instanceof Error, true);
`;
}
