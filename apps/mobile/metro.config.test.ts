import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = path.dirname(fileURLToPath(import.meta.url));

function probeMetro(profile: string): {
  readonly resolution: unknown;
  readonly resolverType: string;
  readonly watchFolders: readonly string[];
  readonly extraNodeModules: Readonly<Record<string, string>>;
} {
  const script = `
    const config = require("./metro.config.js");
    const resolution = config.resolver.resolveRequest
      ? config.resolver.resolveRequest({ originModulePath: require("node:path").resolve("App.tsx"), resolveRequest: () => ({ type: "sourceFile", filePath: "fallback" }) }, "./src/dev-preview", "ios")
      : null;
    console.log(JSON.stringify({ resolution, resolverType: typeof config.resolver.resolveRequest, watchFolders: config.watchFolders, extraNodeModules: config.resolver.extraNodeModules }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["-e", script], {
      cwd: mobileRoot,
      encoding: "utf8",
      env: { ...process.env, CHALK_APP_VARIANT: profile, EAS_BUILD_PROFILE: "", NODE_ENV: "test" },
    }).trim(),
  ) as {
    readonly resolution: unknown;
    readonly resolverType: string;
    readonly watchFolders: readonly string[];
    readonly extraNodeModules: Readonly<Record<string, string>>;
  };
}

describe("mobile Metro configuration", () => {
  it("replaces the preview entry with a production stub", () => {
    const result = probeMetro("production");

    expect(result.resolverType).toBe("function");
    expect(result.resolution).toEqual({ type: "sourceFile", filePath: path.join(mobileRoot, "src/dev-preview/production-stub.tsx") });
  }, 10_000);

  it("resolves the client diagnostics contract from its workspace package", () => {
    const result = probeMetro("development");

    expect(result.watchFolders).toContain(path.resolve(mobileRoot, "../../packages/diagnostics-contracts"));
    expect(result.extraNodeModules).toHaveProperty("@q9labsai/diagnostics-contracts", path.resolve(mobileRoot, "../../packages/diagnostics-contracts"));
  }, 10_000);

  it("prepares native dependencies through the app lifecycle", () => {
    const packageJson = JSON.parse(readFileSync(path.join(mobileRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    expect(packageJson.scripts["prestart:raw"]).toBe("pnpm run prepare:native-dependencies");
    expect(packageJson.scripts["prepare:native-dependencies"]).toContain("pnpm --filter @q9labsai/diagnostics-contracts build");
  });
});
