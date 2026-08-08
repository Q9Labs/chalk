import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const productionConfig = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");

describe("production Cloudflare configuration", () => {
  it("enables the hosted Episode Diagnostics gateway", () => {
    expect(productionConfig).toContain('CHALK_ENVIRONMENT = "production"');
    expect(productionConfig).toContain('CHALK_EPISODE_DIAGNOSTICS = "hosted"');
    expect(productionConfig).toContain('CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN = "true"');
    expect(productionConfig).toContain('CHALK_EPISODE_DIAGNOSTICS_GATEWAY = "verified"');
  });
});
