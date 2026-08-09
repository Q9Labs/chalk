import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = process.cwd();
const workspaceRoot = path.resolve(mobileRoot, "../..");
const require = createRequire(import.meta.url);
type NodeEnv = "development" | "production" | "test";

type MetroConfigProbe = {
  readonly diagnosticsContractsRoot: string;
  readonly diagnosticsWatchFolder: boolean;
  readonly diagnosticsExtraNodeModule: string | undefined;
  readonly resolution: unknown;
  readonly resolverType: string;
};

type MetroResolution = Readonly<{ readonly type: "sourceFile"; readonly filePath: string }>;

function runResolver(profile: string, nodeEnv: NodeEnv = "test"): MetroConfigProbe {
  const script = `
    const path = require("node:path");
    const config = require("./metro.config.js");
    const originModulePath = path.resolve("App.tsx");
    const resolution = config.resolver.resolveRequest
      ? config.resolver.resolveRequest({ originModulePath, resolveRequest: () => ({ type: "sourceFile", filePath: "fallback" }) }, "./src/dev-preview", "ios")
      : null;
    const diagnosticsContractsRoot = path.resolve("../../packages/diagnostics-contracts");
    console.log(JSON.stringify({
      diagnosticsContractsRoot,
      diagnosticsWatchFolder: config.watchFolders.includes(diagnosticsContractsRoot),
      diagnosticsExtraNodeModule: config.resolver.extraNodeModules["@q9labsai/diagnostics-contracts"],
      resolution,
      resolverType: typeof config.resolver.resolveRequest,
    }));
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: mobileRoot,
    encoding: "utf8",
    env: { ...process.env, CHALK_APP_VARIANT: profile, EAS_BUILD_PROFILE: "", NODE_ENV: nodeEnv },
  });
  return JSON.parse(output.trim()) as MetroConfigProbe;
}

function readPackage(packagePath: string): Record<string, unknown> | null {
  if (!existsSync(packagePath)) return null;
  return JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
}

function fileSystemLookup(filePath: string): { readonly exists: false } | { readonly exists: true; readonly type: "d" | "f"; readonly realPath: string } {
  try {
    const realPath = realpathSync(filePath);
    return { exists: true, realPath, type: lstatSync(realPath).isDirectory() ? "d" : "f" };
  } catch {
    return { exists: false };
  }
}

function packageForModule(modulePath: string, fixtureRoot: string): Readonly<{ rootPath: string; packageJson: Record<string, unknown>; packageRelativePath: string }> | null {
  let currentPath = modulePath;
  try {
    if (!lstatSync(currentPath).isDirectory()) currentPath = path.dirname(currentPath);
  } catch {
    currentPath = path.dirname(currentPath);
  }

  while (currentPath.startsWith(fixtureRoot)) {
    const packageJsonPath = path.join(currentPath, "package.json");
    const packageJson = readPackage(packageJsonPath);
    if (packageJson) {
      return { rootPath: currentPath, packageJson, packageRelativePath: path.relative(currentPath, modulePath) };
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  return null;
}

function buildAndResolveDiagnosticsForPlatforms(): Readonly<Record<"ios" | "android", MetroResolution>> {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "chalk-mobile-metro-resolution-"));
  const fixtureDiagnosticsRoot = path.join(fixtureRoot, "packages/diagnostics-contracts");
  const fixtureClientRoot = path.join(fixtureRoot, "sdks/typescript/client");
  const sourceDiagnosticsRoot = path.join(workspaceRoot, "packages/diagnostics-contracts");
  const generatedSegments = new Set(["dist", "node_modules", "tsconfig.tsbuildinfo"]);
  const copyFilter = (sourcePath: string) =>
    !path
      .relative(sourceDiagnosticsRoot, sourcePath)
      .split(path.sep)
      .some((segment) => generatedSegments.has(segment));

  try {
    mkdirSync(path.dirname(fixtureDiagnosticsRoot), { recursive: true });
    mkdirSync(path.join(fixtureClientRoot, "src/space-client"), { recursive: true });
    cpSync(sourceDiagnosticsRoot, fixtureDiagnosticsRoot, { filter: copyFilter, recursive: true });
    cpSync(path.join(workspaceRoot, "tsconfig.json"), path.join(fixtureRoot, "tsconfig.json"));
    symlinkSync(path.join(workspaceRoot, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
    symlinkSync(path.join(sourceDiagnosticsRoot, "node_modules"), path.join(fixtureDiagnosticsRoot, "node_modules"), "dir");
    expect(existsSync(path.join(fixtureDiagnosticsRoot, "dist"))).toBe(false);

    const rootTsup = path.join(workspaceRoot, "node_modules/.bin/tsup");
    const rootTsc = path.join(workspaceRoot, "node_modules/.bin/tsc");
    execFileSync(rootTsup, ["./src/index.ts", "--format", "esm", "--out-dir", "./dist", "--platform", "node", "--no-splitting"], { cwd: fixtureDiagnosticsRoot, stdio: "ignore" });
    execFileSync(rootTsc, ["--emitDeclarationOnly", "--declaration", "--outDir", "dist"], { cwd: fixtureDiagnosticsRoot, stdio: "ignore" });
    expect(existsSync(path.join(fixtureDiagnosticsRoot, "dist/index.js"))).toBe(true);

    mkdirSync(path.join(fixtureClientRoot, "node_modules/@q9labsai"), { recursive: true });
    symlinkSync(fixtureDiagnosticsRoot, path.join(fixtureClientRoot, "node_modules/@q9labsai/diagnostics-contracts"), "dir");
    const originModulePath = path.join(fixtureClientRoot, "src/space-client/episode-diagnostic-runtime.js");
    writeFileSync(originModulePath, "");

    const mobileConfig = require(path.join(mobileRoot, "metro.config.js")) as {
      readonly resolver: {
        readonly assetExts: readonly string[];
        readonly resolverMainFields: readonly string[];
        readonly sourceExts: readonly string[];
        readonly unstable_conditionNames: readonly string[];
        readonly unstable_conditionsByPlatform: Readonly<Record<string, readonly string[]>>;
        readonly unstable_enablePackageExports: boolean;
      };
    };
    const expoPackagePath = require.resolve("expo/package.json", { paths: [mobileRoot] });
    const metroResolver = require(require.resolve("metro-resolver", { paths: [path.dirname(expoPackagePath)] })) as {
      readonly resolve: (context: Record<string, unknown>, moduleName: string, platform: "ios" | "android") => MetroResolution;
    };
    const packageCache = new Map<string, Record<string, unknown>>();
    const cachedReadPackage = (packagePath: string) => {
      if (!packageCache.has(packagePath)) packageCache.set(packagePath, readPackage(packagePath) ?? {});
      return packageCache.get(packagePath) ?? null;
    };
    const resolverContext = {
      allowHaste: false,
      assetExts: new Set(mobileConfig.resolver.assetExts),
      customResolverOptions: {},
      disableHierarchicalLookup: false,
      doesFileExist: existsSync,
      extraNodeModules: { "@q9labsai/diagnostics-contracts": fixtureDiagnosticsRoot },
      dev: false,
      getPackage: cachedReadPackage,
      getPackageForModule: (modulePath: string) => packageForModule(modulePath, fixtureRoot),
      fileSystemLookup,
      mainFields: mobileConfig.resolver.resolverMainFields,
      originModulePath,
      nodeModulesPaths: [path.join(fixtureClientRoot, "node_modules"), path.join(fixtureRoot, "node_modules")],
      preferNativePlatform: true,
      resolveAsset: () => null,
      redirectModulePath: (modulePath: string) => modulePath,
      resolveHasteModule: () => null,
      resolveHastePackage: () => null,
      resolveRequest: null,
      sourceExts: mobileConfig.resolver.sourceExts,
      unstable_conditionNames: mobileConfig.resolver.unstable_conditionNames,
      unstable_conditionsByPlatform: mobileConfig.resolver.unstable_conditionsByPlatform,
      unstable_enablePackageExports: mobileConfig.resolver.unstable_enablePackageExports,
      unstable_logWarning: () => undefined,
      isESMImport: true,
    };

    return {
      ios: metroResolver.resolve(resolverContext, "@q9labsai/diagnostics-contracts", "ios"),
      android: metroResolver.resolve(resolverContext, "@q9labsai/diagnostics-contracts", "android"),
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

describe("mobile Metro SDK preview resolver", () => {
  it("replaces the preview entry with a production stub", () => {
    const result = runResolver("production");

    expect(result.resolverType).toBe("function");
    expect(result.resolution).toEqual({ type: "sourceFile", filePath: path.resolve(mobileRoot, "src/dev-preview/production-stub.tsx") });
  }, 10_000);

  it("maps the workspace diagnostics package for Metro", () => {
    const result = runResolver("development");

    expect(result.diagnosticsWatchFolder).toBe(true);
    expect(result.diagnosticsExtraNodeModule).toBe(result.diagnosticsContractsRoot);
  }, 10_000);

  it("builds a clean diagnostics package and resolves it for iOS and Android", () => {
    const resolutions = buildAndResolveDiagnosticsForPlatforms();
    const expectedSuffix = `${path.sep}packages${path.sep}diagnostics-contracts${path.sep}dist${path.sep}index.js`;

    expect(resolutions.ios.filePath).toContain(expectedSuffix);
    expect(resolutions.android.filePath).toContain(expectedSuffix);
    expect(resolutions.ios.filePath).toBe(resolutions.android.filePath);
  }, 30_000);

  it("prepares native dependencies through the raw start lifecycle once", () => {
    const packageJson = JSON.parse(readFileSync(path.join(mobileRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    expect(packageJson.scripts["prestart:raw"]).toBe("pnpm run prepare:native-dependencies");
    expect(packageJson.scripts.start).toBe("node ../../scripts/dev-log.mjs start:raw");
    expect(packageJson.scripts["start:raw"]).toBe("expo start --clear");
  });
});
