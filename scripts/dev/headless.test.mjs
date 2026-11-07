import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enableSeedInvite, proveSeededSignIn } from "./chalk-signin.mjs";
import { runCommand } from "./commands.mjs";
import { DevCommand, resolveDevConfig } from "./config.mjs";
import { createSecretResolver, sfuCredentialsFromEnv } from "./secrets.mjs";

const tools = ["node"];

test("SFU credentials come from the environment and never call op", async () => {
  const env = { CHALK_CLOUDFLARE_REALTIME_APP_ID: "id-1", CHALK_CLOUDFLARE_REALTIME_APP_SECRET: "secret-1" };
  const credentials = await createSecretResolver({ env, op: "/nonexistent/op" })();
  assert.equal(credentials.appId, "id-1");
  assert.equal(credentials.appSecret, "secret-1");
  assert.deepEqual(credentials.redactions, ["id-1", "secret-1"]);
});

test("a half-set SFU credential fails startup", () => {
  assert.throws(() => sfuCredentialsFromEnv({ CHALK_CLOUDFLARE_REALTIME_APP_ID: "id-1" }), /must be set together/);
  assert.equal(sfuCredentialsFromEnv({}), undefined);
});

test("PUBLIC_ORIGIN drives the issuer and the public URL, and the default stays chalk.local", () => {
  const base = { root: tmpdir(), requiredTools: tools, secretResolver: async () => undefined };
  const local = resolveDevConfig({ ...base, env: {} });
  assert.equal(local.auth.issuer, "http://chalk.local");
  assert.equal(local.urls.public, local.urls.web);
  const public_ = resolveDevConfig({ ...base, env: { PUBLIC_ORIGIN: "https://orb.example.com" } });
  assert.equal(public_.auth.issuer, "https://orb.example.com");
  assert.equal(public_.urls.public, "https://orb.example.com");
  assert.throws(() => resolveDevConfig({ ...base, env: { PUBLIC_ORIGIN: "https://orb.example.com/path" } }), /PUBLIC_ORIGIN/);
  assert.throws(() => resolveDevConfig({ ...base, env: { PUBLIC_ORIGIN: "not a url" } }), /PUBLIC_ORIGIN/);
});

test("the seed invite is enabled and its code is read from the canonical URL", async () => {
  const calls = [];
  const invite = await enableSeedInvite({
    apiOrigin: "http://127.0.0.1:8080",
    systemToken: "t",
    tenantId: "tenant",
    spaceId: "space",
    fetchImpl: async (url, init) => {
      calls.push({ path: new URL(url).pathname, method: init.method });
      return Response.json({ canonical_url: "https://chalkmeet.com/abc-def-ghi" });
    },
  });
  assert.deepEqual(calls, [{ path: "/v1/tenants/tenant/spaces/space/public-invite", method: "PATCH" }]);
  assert.deepEqual(invite, { code: "abc-def-ghi", path: "/abc-def-ghi" });
});

function signInFetch({ arrivalStatus = 201, leaveStatus = 204 } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    seen.push({ pathname, method: init.method ?? "GET", init });
    if (pathname === "/abc") return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    if (pathname === "/v1/public/space-invite-arrivals") {
      return new Response(JSON.stringify({ arrival_handle: "handle", state: "admitted" }), { status: arrivalStatus, headers: { "set-cookie": "__Host-chalk_space_guest_x=v; Path=/; Secure" } });
    }
    return new Response(null, { status: leaveStatus });
  };
  return { fetchImpl, seen };
}

test("the sign-in probe arrives, presents the guest cookie, and leaves", async () => {
  const { fetchImpl, seen } = signInFetch();
  const proof = await proveSeededSignIn({ origin: "http://127.0.0.1:3070", invite: { code: "abc", path: "/abc" }, fetchImpl });
  assert.equal(proof.state, "admitted");
  const leave = seen.at(-1);
  assert.equal(leave.method, "DELETE");
  assert.equal(leave.init.headers.Cookie, "__Host-chalk_space_guest_x=v");
  assert.equal(leave.init.headers["X-Chalk-Arrival-Handle"], "handle");
});

test("the sign-in probe fails with the stage and response when arrival is refused", async () => {
  const { fetchImpl } = signInFetch({ arrivalStatus: 403 });
  await assert.rejects(proveSeededSignIn({ origin: "http://127.0.0.1:3070", invite: { code: "abc", path: "/abc" }, fetchImpl }), /arrival through .* failed with HTTP 403/);
});

test("the sign-in probe retries a provider failure once and then admits the guest", async () => {
  let arrivals = 0;
  const { fetchImpl } = signInFetch();
  const flaky = async (url, init) => (new URL(url).pathname === "/v1/public/space-invite-arrivals" && (arrivals += 1) === 1 ? new Response("{}", { status: 500 }) : fetchImpl(url, init));
  const proof = await proveSeededSignIn({ origin: "http://127.0.0.1:3070", invite: { code: "abc", path: "/abc" }, fetchImpl: flaky, retryDelayMs: 1 });
  assert.equal(proof.state, "admitted");
  assert.equal(arrivals, 2);
});

test("doctor reports each failed check and exits not ok", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-doctor-"));
  const config = resolveDevConfig({ root, env: {}, requiredTools: tools, secretResolver: async () => undefined });
  await mkdir(config.paths?.privateDir ?? join(root, ".private/chalk-dev"), { recursive: true });
  await writeFile(config.seedPath, JSON.stringify({ invite: { code: "abc", path: "/abc" } }));
  const output = [];
  const result = await runCommand(DevCommand.DOCTOR, config, {
    output: (line) => output.push(line),
    hooks: { validatePid: async () => true, headRevision: async () => "rev", fetchImpl: async () => new Response("ok"), proveSignIn: async () => ({ state: "admitted" }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((entry) => entry.name === "owner").ok, false);
  assert.equal(result.checks.find((entry) => entry.name === "sign-in").ok, true);
  assert.equal(JSON.parse(output.join("\n")).ok, false);
});
