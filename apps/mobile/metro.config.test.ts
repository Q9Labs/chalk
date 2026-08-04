import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = process.cwd();
type NodeEnv = "development" | "production" | "test";

function runResolver(profile: string, nodeEnv: NodeEnv = "test"): { readonly resolution: unknown; readonly resolverType: string } {
  const script = `
    const path = require("node:path");
    const config = require("./metro.config.js");
    const originModulePath = path.resolve("App.tsx");
    const resolution = config.resolver.resolveRequest
      ? config.resolver.resolveRequest({ originModulePath, resolveRequest: () => ({ type: "sourceFile", filePath: "fallback" }) }, "./src/dev-preview", "ios")
      : null;
    console.log(JSON.stringify({ resolution, resolverType: typeof config.resolver.resolveRequest }));
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: mobileRoot,
    encoding: "utf8",
    env: { ...process.env, CHALK_APP_VARIANT: profile, EAS_BUILD_PROFILE: "", NODE_ENV: nodeEnv },
  });
  return JSON.parse(output.trim()) as { readonly resolution: unknown; readonly resolverType: string };
}

describe("mobile Metro SDK preview resolver", () => {
  it("replaces the preview entry with a production stub", () => {
    const result = runResolver("production");

    expect(result.resolverType).toBe("function");
    expect(result.resolution).toEqual({ type: "sourceFile", filePath: path.resolve(mobileRoot, "src/dev-preview/production-stub.tsx") });
  }, 10_000);
});
