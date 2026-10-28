import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { load, loadAll } from "js-yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = load(readFileSync(process.env.WEB_PROOF_WORKFLOW_PATH ?? join(root, ".github/workflows/web-call-proof.yml"), "utf8"));
const steps = workflow.jobs.web.steps;
const requireEngine = createRequire(import.meta.resolve("@e2e-dev/web"));
const playwrightRoot = dirname(requireEngine.resolve("playwright-core/package.json"));
const version = requireEngine("playwright-core/package.json").version;

function temporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "chalk-web-browser-cache-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("web browser cache key follows the engine's lockfile version, not the SDK's", () => {
  const lock = loadAll(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).find((document) => document.importers?.["sdks/typescript/client"]);
  const engine = lock.importers["."].devDependencies["@e2e-dev/web"].version;
  assert.equal(version, lock.snapshots[`@e2e-dev/web@${engine}`].dependencies["playwright-core"]);
  const key = steps.find((step) => step.id === "web-browser-key");
  assert.ok(key, "web proof needs its own engine browser key");
  temporaryDirectory((directory) => {
    const output = join(directory, "output");
    execFileSync("bash", ["-e", "-c", key.run], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output, ImageOS: "ubuntu24", RUNNER_ARCH: "X64" },
    });
    assert.equal(readFileSync(output, "utf8").trim(), `key=e2e-web-playwright-${version}-chromium-webkit-ubuntu24-X64`);
  });
});

for (const cacheState of ["miss", "hit"]) {
  test(`web engine Chromium installs before proof on a cache ${cacheState}`, () => {
    const restore = steps.findIndex((step) => step.id === "web-browser-cache");
    const install = steps.findIndex((step) => step.run === "pnpm exec e2e-web install chromium webkit --with-deps");
    const verify = steps.findIndex((step) => step.uses === "./.github/actions/setup-playwright");
    const save = steps.findIndex((step) => step.uses?.startsWith("actions/cache/save@"));
    const proof = steps.findIndex((step) => step.run === "pnpm web:proof");
    assert.ok(restore >= 0 && restore < install && install < verify && verify < save && save < proof);
    assert.equal(steps[verify].if, undefined);
    assert.equal(steps[install].if, undefined, `a cache ${cacheState} must not skip the engine installer`);
    assert.equal(steps[restore].with.path, "~/.cache/ms-playwright");
    assert.deepEqual(steps[save].with, steps[restore].with);
    assert.equal(steps[restore].with.key, "${{ steps.web-browser-key.outputs.key }}");
    assert.equal(steps[restore].with["restore-keys"], undefined);
    assert.equal(steps[proof]["timeout-minutes"], 7);
  });
}

test("both runtimes are verified after the final shared cache restore and before any save", () => {
  const sdk = steps.findIndex((step) => step.uses === "./.github/actions/setup-playwright");
  const restore = steps.findIndex((step) => step.id === "web-browser-cache");
  const install = steps.findIndex((step) => step.run === "pnpm exec e2e-web install chromium webkit --with-deps");
  const save = steps.findIndex((step) => step.uses?.startsWith("actions/cache/save@"));
  assert.ok(restore >= 0 && restore < install && install < sdk && sdk < save);
  assert.equal(steps[sdk].with.browsers, "chromium webkit");
  assert.equal(steps[sdk].with["verify-engine"], true);
  const action = load(readFileSync(process.env.SDK_PLAYWRIGHT_ACTION_PATH ?? new URL("../../.github/actions/setup-playwright/action.yml", import.meta.url), "utf8"));
  const sdkRestore = action.runs.steps.findIndex((step) => step.uses?.startsWith("actions/cache/restore@"));
  const sdkInstall = action.runs.steps.findIndex((step) => step.run?.includes("install_once()"));
  const verify = action.runs.steps.findIndex((step) => step.run?.includes("node scripts/ensure-playwright-browsers.mjs sdk"));
  const sdkSave = action.runs.steps.findIndex((step) => step.uses?.startsWith("actions/cache/save@"));
  assert.ok(sdkRestore >= 0 && sdkRestore < sdkInstall && sdkInstall < verify && verify < sdkSave);
  assert.equal(action.runs.steps[verify].if, undefined);
  assert.equal(action.inputs["verify-engine"].default, "false");
  assert.equal(action.runs.steps[verify].env.VERIFY_ENGINE, "${{ inputs.verify-engine }}");
  assert.match(action.runs.steps[verify].run, /node scripts\/ensure-playwright-browsers\.mjs engine chromium/);
});

test("engine install dry-run provisions its full Chromium and headless-shell revisions in the cached directory", () => {
  const { browsers } = JSON.parse(readFileSync(join(playwrightRoot, "browsers.json"), "utf8"));
  temporaryDirectory((directory) => {
    const cache = join(directory, ".cache", "ms-playwright");
    const output = execFileSync(process.execPath, [join(playwrightRoot, "cli.js"), "install", "--dry-run", "chromium"], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache },
      encoding: "utf8",
    });
    for (const [name, folder] of [
      ["chromium", "chromium"],
      ["chromium-headless-shell", "chromium_headless_shell"],
    ]) {
      const { revision } = browsers.find((browser) => browser.name === name);
      assert.ok(output.includes(join(cache, `${folder}-${revision}`)), output);
    }
  });
});
