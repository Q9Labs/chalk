import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Run after building the client, from a workspace install including apps/mobile.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const mobile = path.join(root, "apps/mobile");
const appRequire = createRequire(path.join(mobile, "package.json"));
const expoRequire = createRequire(appRequire.resolve("expo/package.json"));
const Metro = expoRequire("metro");
const temporary = await mkdtemp(path.join(mobile, ".native-client-"));
const output = process.env.CHALK_NATIVE_CLIENT_ARTIFACTS;

try {
  const entry = path.join(temporary, "index.js");
  await writeFile(
    entry,
    `
import { createChalkPublicClient } from "@q9labsai/chalk-client/invites";
const client = createChalkPublicClient({
  baseUrl: "https://native-client.invalid",
  runtime: "react-native",
  fetch: async () => {
    globalThis.__chalkNativeTransportReached = true;
    throw new Error("CHALK_NATIVE_TRANSPORT_REACHED");
  },
});
if (typeof client.createPublicSpace !== "function") throw new Error("Public client did not load");
globalThis.__chalkNativeClientLoaded = true;
globalThis.__chalkNativeExercise = () => client.createPublicSpace({ displayName: "Native smoke" }, { idempotencyKey: "00000000-0000-4000-8000-000000000001" });
console.log("CHALK_NATIVE_CLIENT_LOADED");
`,
  );
  for (const platform of ["ios", "android"]) {
    for (const dev of [true, false]) {
      const config = await Metro.loadConfig({ cwd: mobile, config: path.join(mobile, "metro.config.js"), resetCache: true });
      config.maxWorkers = 2;
      config.watchman = false;
      // Eager imports catch HTTP API initialization failures normally deferred until joining.
      config.transformer.getTransformOptions = async () => ({ transform: { experimentalImportSupport: false, inlineRequires: false } });
      // This entry exercises the SDK, not native React Native startup globals.
      config.serializer.getPolyfills = () => [];
      config.serializer.getModulesRunBeforeMainModule = () => [];
      const result = await Metro.runBuild(config, {
        entry,
        platform,
        dev,
        minify: !dev,
        customTransformOptions: { engine: platform === "ios" ? "jsc" : "hermes" },
        unstable_transformProfile: platform === "ios" ? "default" : "hermes-stable",
      });
      const name = `${platform}-${dev ? "dev" : "release"}`;
      if (output) await writeFile(path.join(output, `${name}.js`), result.code);
      const context = vm.createContext({
        console,
        process: { env: { NODE_ENV: dev ? "development" : "production" } },
        setTimeout,
        clearTimeout,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        AbortController,
        AbortSignal,
        Headers,
        Request,
        Response,
        FormData,
      });
      vm.runInContext(result.code, context, { filename: `${name}.js`, timeout: 30_000 });
      assert.equal(context.__chalkNativeClientLoaded, true);
      await assert.rejects(context.__chalkNativeExercise());
      assert.equal(context.__chalkNativeTransportReached, true);
      console.log(`PASS ${name}`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
