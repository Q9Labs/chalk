import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCommand } from "./commands.mjs";
import { chalkSfuPlane, cloudflareSfuPlane, resolveDevConfig } from "./config.mjs";
import { seedDashboard } from "./dashboard-seed.mjs";

test("public Orbs use the Cloudflare SFU and require credentials", async (t) => {
  const home = await temporaryHome(t);
  await writeFile(join(home, ".orb.json"), "{}");
  const env = { PUBLIC_ORIGIN: "https://example.test" };
  const config = resolveDevConfig({ home, env });
  assert.equal(config.mediaPlane, cloudflareSfuPlane);
  assert.ok(config.requiredTools.includes("op"));
  const withCredentials = resolveDevConfig({
    home,
    env: { ...env, CHALK_CLOUDFLARE_REALTIME_APP_ID: "dev-app", CHALK_CLOUDFLARE_REALTIME_APP_SECRET: "dev-secret" },
  });
  assert.ok(!withCredentials.requiredTools.includes("op"));
});

test("only an Orb can opt in to a local Chalk SFU without Cloudflare credentials", async (t) => {
  const home = await temporaryHome(t);
  const env = { PUBLIC_ORIGIN: "https://example.test", CHALK_DEV_ORB_LOCAL_SFU: "1" };
  assert.equal(resolveDevConfig({ home, env }).mediaPlane, cloudflareSfuPlane);
  await writeFile(join(home, ".orb.json"), "{}");
  const config = resolveDevConfig({ home, env });
  assert.equal(config.mediaPlane, chalkSfuPlane);
  assert.ok(!config.requiredTools.includes("op"));
});

test("Orb doctor uses the seed's plane without the launch environment", async (t) => {
  const home = await temporaryHome(t);
  const config = resolveDevConfig({ home, root: home, env: {} });
  await mkdir(dirname(config.seedPath), { recursive: true });
  await writeFile(config.seedPath, JSON.stringify({ invite: { path: "/test" }, signInMediaPlane: chalkSfuPlane }));
  let plane;
  const result = await runCommand("doctor", config, {
    hooks: {
      headRevision: async () => "test",
      fetchImpl: async () => new Response("ready"),
      proveSignIn: async ({ mediaPlane }) => {
        plane = mediaPlane;
        return { state: "admitted" };
      },
    },
    output() {},
  });
  assert.equal(result.checks.find(({ name }) => name === "sign-in").ok, true);
  assert.equal(plane, chalkSfuPlane);
});

for (const [mode, initialPlane, expectedPlane] of [
  ["public", null, cloudflareSfuPlane],
  ["local SFU", cloudflareSfuPlane, null],
]) {
  test(`the ${mode} Orb dashboard updates the Tenant from a warm snapshot`, async (t) => {
    const home = await temporaryHome(t);
    await writeFile(join(home, ".orb.json"), "{}");
    const config = resolveDevConfig({ home, env: { CHALK_DEV_ORB_LOCAL_SFU: mode === "local SFU" ? "1" : "0" } });
    let defaultMediaPlane = initialPlane;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      switch (new URL(url).pathname) {
        case "/v1/tenants":
          assert.equal(JSON.parse(options.body).external_id, "google:local:fixture_ada");
          return Response.json({ id: "ada", default_media_plane: defaultMediaPlane });
        case "/v1/tenants/ada": {
          assert.equal(options.method, "PATCH");
          assert.equal(options.headers.Authorization, "Bearer system-token");
          const patch = JSON.parse(options.body);
          if (expectedPlane) assert.equal(patch.media_plane_provider_config.provider, expectedPlane);
          defaultMediaPlane = patch.default_media_plane;
          return Response.json({ id: "ada", default_media_plane: defaultMediaPlane });
        }
        case "/v1/tenants/ada/spaces":
          return new Response("stop before storage writes", { status: 503 });
        default:
          assert.fail(`unexpected API request to ${url}`);
      }
    });
    await assert.rejects(seedDashboard({ config, serviceToken: "dashboard-token", systemToken: "system-token" }), /spaces.*HTTP 503/);
    assert.equal(defaultMediaPlane, expectedPlane);
  });
}

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), "chalk-orb-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
