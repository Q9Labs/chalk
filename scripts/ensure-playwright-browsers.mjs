import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function ensurePlaywrightBrowsers(runtime, browsers, runProcess = spawnSync) {
  if (!["sdk", "engine"].includes(runtime) || !browsers.length || browsers.some((browser) => !["chromium", "firefox", "webkit"].includes(browser))) {
    throw new Error("Usage: ensure-playwright-browsers.mjs sdk|engine chromium|firefox|webkit [...]");
  }
  const sdk = createRequire(new URL("../sdks/typescript/client/package.json", import.meta.url));
  const requireRuntime = runtime === "engine" ? createRequire(import.meta.resolve("@e2e-dev/web")) : createRequire(sdk.resolve("playwright"));
  const core = dirname(requireRuntime.resolve("playwright-core/package.json"));
  const playwright = requireRuntime("playwright-core");
  const {
    registry: { registry },
  } = requireRuntime(join(core, "lib/coreBundle.js"));
  const executables = browsers.flatMap((browser) => {
    const full = registry.findExecutable(browser);
    const entries = [{ browser, directory: full.directory, path: playwright[browser].executablePath() }];
    if (browser === "chromium") {
      const shell = registry.findExecutable("chromium-headless-shell");
      entries.push({ browser, directory: shell.directory, path: shell.executablePath() });
    }
    return entries;
  });
  const unusable = () =>
    executables.filter(({ browser, path }) => {
      const source = `require(${JSON.stringify(core)})[${JSON.stringify(browser)}]
      .launch({ executablePath: process.argv[1], headless: true })
      .then(browser => browser.close()).catch(error => { console.error(error.message); process.exitCode = 1; });`;
      const result = runProcess(process.execPath, ["-e", source, path], { encoding: "utf8", timeout: 60000 });
      if (result.status !== 0) console.error(result.error?.message ?? result.stderr);
      return result.status !== 0;
    });
  const incomplete = unusable();
  if (!incomplete.length) return;
  for (const { directory, path } of incomplete) {
    console.log(`Repairing ${runtime} Playwright cache: unusable executable ${path}`);
    rmSync(directory, { recursive: true, force: true });
  }
  const result = runProcess(process.execPath, [join(core, "cli.js"), "install", ...new Set(incomplete.map(({ browser }) => browser))], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${runtime} Playwright cache repair installer failed: ${result.error?.message ?? result.signal ?? result.status}`);
  }
  const remaining = unusable();
  if (remaining.length) {
    throw new Error(`${runtime} Playwright browsers still cannot launch after cache repair: ${remaining.map(({ path }) => path).join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensurePlaywrightBrowsers(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
