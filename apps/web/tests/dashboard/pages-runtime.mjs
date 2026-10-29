import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { unstable_generateASSETSBinding, unstable_readConfig } from "wrangler";

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const [web, port, serializedBindings] = process.argv.slice(2);
const config = unstable_readConfig({ config: resolve(web, "wrangler.toml") });
const directory = config.pages_build_output_dir;
const worker = resolve(directory, "_worker.js");
const entrypoint = (await stat(worker)).isDirectory() ? resolve(worker, "index.js") : worker;
const controller = new AbortController();
const assets = await unstable_generateASSETSBinding({ directory, log: console, signal: controller.signal });
// The proof serves an immutable build, without the dev proxy's pooled TCP hop.
const runtime = new Miniflare({
  cf: false,
  host: "127.0.0.1",
  port: Number(port),
  modules: true,
  scriptPath: entrypoint,
  modulesRoot: dirname(entrypoint),
  modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  bindings: JSON.parse(serializedBindings),
  serviceBindings: { ASSETS: assets },
});
async function stop() {
  controller.abort();
  await runtime.dispose();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
await runtime.ready;
console.log("Pages proof runtime ready");
