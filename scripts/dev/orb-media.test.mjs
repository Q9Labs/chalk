import assert from "node:assert/strict";
import test from "node:test";
import { resolveDevConfig } from "./config.mjs";

test("published Orbs always select Chalk SFU even with Cloudflare credentials", () => {
  for (const origin of ["https://3070-example.instabox.tech", "https://example.trycloudflare.com"]) {
    const config = resolveDevConfig({ env: {
      PUBLIC_ORIGIN: origin,
      CHALK_CLOUDFLARE_REALTIME_APP_ID: "unused-app",
      CHALK_CLOUDFLARE_REALTIME_APP_SECRET: "unused-secret",
    } });
    assert.equal(config.mediaPlane, "chalk_sfu");
    assert.ok(!config.requiredTools.includes("op"));
  }
});

test("the Orb default does not change a local checkout's plane", () => {
  assert.equal(resolveDevConfig({ env: {} }).mediaPlane, "cf_sfu");
});
