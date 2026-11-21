import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCommand } from "./commands.mjs";
import { chalkSfuPlane, cloudflareSfuPlane, resolveDevConfig } from "./config.mjs";
import { seedDashboard } from "./dashboard-seed.mjs";

test("the Orb launch marker selects Chalk SFU regardless of preview origin or credentials", async (t) => {
  const home = await temporaryHome(t);
  await writeFile(join(home, ".orb.json"), "{}");
  for (const origin of ["https://3070-example.instabox.tech", "https://example.trycloudflare.com", "https://orb.example.test"]) {
    const config = resolveDevConfig({
      home,
      env: {
        PUBLIC_ORIGIN: origin,
        CHALK_CLOUDFLARE_REALTIME_APP_ID: "unused-app",
        CHALK_CLOUDFLARE_REALTIME_APP_SECRET: "unused-secret",
      },
    });
    assert.equal(config.mediaPlane, chalkSfuPlane);
    assert.ok(!resolveDevConfig({ home, env: { PUBLIC_ORIGIN: origin } }).requiredTools.includes("op"));
  }
});

test("a local Quick Tunnel does not change a local checkout's plane", async (t) => {
  const home = await temporaryHome(t);
  assert.equal(resolveDevConfig({ home, env: {} }).mediaPlane, cloudflareSfuPlane);
  assert.equal(resolveDevConfig({ home, env: { PUBLIC_ORIGIN: "https://example.trycloudflare.com" } }).mediaPlane, cloudflareSfuPlane);
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

test("Orb dashboard clears a warm fixture Tenant's Cloudflare default before seeding Spaces", async (t) => {
  const home = await temporaryHome(t);
  const config = { ...resolveDevConfig({ home, env: {} }), orb: true, mediaPlane: chalkSfuPlane };
  let defaultMediaPlane = cloudflareSfuPlane;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    switch (new URL(url).pathname) {
      case "/v1/tenants":
        assert.equal(JSON.parse(options.body).external_id, "google:local:fixture_ada");
        return Response.json({ id: "ada", default_media_plane: defaultMediaPlane });
      case "/v1/tenants/ada":
        assert.equal(options.method, "PATCH");
        assert.equal(options.headers.Authorization, "Bearer system-token");
        defaultMediaPlane = JSON.parse(options.body).default_media_plane;
        return Response.json({ id: "ada", default_media_plane: defaultMediaPlane });
      case "/v1/tenants/ada/spaces":
        return new Response("stop before storage writes", { status: 503 });
      default:
        assert.fail(`unexpected API request to ${url}`);
    }
  });
  await assert.rejects(seedDashboard({ config, serviceToken: "dashboard-token", systemToken: "system-token" }), /spaces.*HTTP 503/);
  assert.equal(defaultMediaPlane, null);
});

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), "chalk-orb-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
