import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildReleasePlan, parseArguments, parseDeploymentURL, recoverStaleReleaseLock, resolveTurboCacheDirectory, runLocalWebRelease, runWebRelease, withReleaseLock } from "./deploy-web-release.mjs";

const fullSHA = "040a7c52698f8cf9b87b0ef48f918b681de9bc35";
const temporaryDirectories = [];
const installCommand = "pnpm\0install\0--frozen-lockfile\0--prefer-offline";
const wranglerVersionCommand = "pnpm\0exec\0wrangler\0--version";

function serializeReleaseCommand({ command, args }) {
  return [command, ...args].join("\0");
}

function createReleaseCommandRunner({ calls = [], stagingOutput = "Take a peek over at https://abc123.chalk-staging.pages.dev" } = {}) {
  const responses = new Map([
    ["git\0rev-parse\0HEAD", { stdout: fullSHA, stderr: "" }],
    ["git\0status\0--porcelain=v1\0--untracked-files=all", { stdout: "", stderr: "" }],
    ["node\0--version", { stdout: "v22.14.0", stderr: "" }],
    ["pnpm\0--version", { stdout: "10.26.2", stderr: "" }],
    [wranglerVersionCommand, { stdout: "4.107.0", stderr: "" }],
    [`pnpm\0exec\0wrangler\0pages\0deploy\0dist/client\0--project-name\0chalk-staging\0--branch\0staging\0--commit-hash\0${fullSHA}\0--commit-dirty=false`, { stdout: stagingOutput, stderr: "" }],
  ]);

  return async (command) => {
    calls.push(command);
    return responses.get(serializeReleaseCommand(command)) ?? { stdout: "", stderr: "" };
  };
}

async function runRecordedWebRelease() {
  const calls = [];
  await runWebRelease({
    arguments_: ["--sha", fullSHA],
    environment: { CLOUDFLARE_API_TOKEN: "injected-by-test" },
    commandRunner: createReleaseCommandRunner({ calls }),
    rootDirectory: "/repo",
    webPath: "/repo/apps/web",
    productionURL: "https://chalkmeet.com",
  });
  return calls;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("parses the explicit release controls and enforces a full SHA in CI", () => {
  assert.deepEqual(parseArguments(["--", "--dry-run"]), {
    sha: undefined,
    skipStaging: false,
    dryRun: true,
    recoverStaleLock: false,
  });
  assert.deepEqual(parseArguments(["--sha", fullSHA, "--skip-staging"]), {
    sha: fullSHA,
    skipStaging: true,
    dryRun: false,
    recoverStaleLock: false,
  });
  assert.deepEqual(parseArguments(["--sha=" + fullSHA, "--dry-run"], { isCI: true }), {
    sha: fullSHA,
    skipStaging: false,
    dryRun: true,
    recoverStaleLock: false,
  });
  assert.throws(() => parseArguments([], { isCI: true }), /required in CI/);
  assert.throws(() => parseArguments(["--sha", fullSHA, "--recover-stale-lock"], { isCI: true }), /only available for local releases/);
  assert.throws(() => parseArguments(["--sha", fullSHA.slice(0, 7)]), /full 40-character/);
});

test("recovers an explicitly requested stale release lock but protects a live owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-web-release-lock-test-"));
  temporaryDirectories.push(directory);
  const staleLock = join(directory, "stale.lock");
  await mkdir(staleLock);
  await writeFile(join(staleLock, "owner.json"), JSON.stringify({ pid: 99_999_999, acquiredAt: new Date().toISOString() }));

  await recoverStaleReleaseLock(staleLock);
  let ran = false;
  await withReleaseLock(staleLock, async () => {
    ran = true;
  });
  assert.equal(ran, true);

  const liveLock = join(directory, "live.lock");
  await mkdir(liveLock);
  await writeFile(join(liveLock, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  await assert.rejects(() => recoverStaleReleaseLock(liveLock), /still running/);

  const invalidLock = join(directory, "invalid.lock");
  await mkdir(invalidLock);
  await writeFile(join(invalidLock, "owner.json"), "null");
  await assert.rejects(() => recoverStaleReleaseLock(invalidLock), /owner PID is invalid/);
});

test("defaults to the exact local HEAD SHA when no CI SHA is supplied", async () => {
  const calls = [];
  const result = await runWebRelease({
    arguments_: ["--dry-run"],
    environment: {},
    commandRunner: createReleaseCommandRunner({ calls }),
    rootDirectory: "/repo",
    webPath: "/repo/apps/web",
  });

  assert.equal(result.sha, fullSHA);
  assert.equal(calls.filter(({ command }) => command === "git").length, 2);
  assert.deepEqual(result.plan[1].args.slice(-2), ["--cache-dir", "/repo/.turbo/cache"]);
});

test("keeps CI dry-run plans on the checked-out persistent cache", async () => {
  const calls = [];
  const result = await runWebRelease({
    arguments_: ["--sha", fullSHA, "--dry-run"],
    environment: { CI: "true", GITHUB_ACTIONS: "true" },
    commandRunner: createReleaseCommandRunner({ calls }),
    rootDirectory: "/ci/release",
    webPath: "/ci/release/apps/web",
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.plan[1].args.slice(-2), ["--cache-dir", "/ci/release/.turbo/cache"]);
  assert.equal(calls.length, 2);
});

test("extracts only the staging Pages URL and keeps the production plan on one artifact", () => {
  assert.equal(parseDeploymentURL("Take a peek over at https://abc123.chalk-staging.pages.dev"), "https://abc123.chalk-staging.pages.dev");
  assert.throws(() => parseDeploymentURL("https://abc123.chalk.pages.dev"), /chalk-staging/);

  const plan = buildReleasePlan({ sha: fullSHA });
  assert.equal(plan.filter(({ args }) => args.includes("run") && args.includes("build")).length, 1);
  assert.equal(plan.filter(({ args }) => args.includes("pages") && args.includes("deploy")).length, 2);
  assert.equal(plan.filter(({ args }) => args.some((argument) => argument.endsWith("verify-web-deploy.mjs"))).length, 2);
  assert.equal(buildReleasePlan({ sha: fullSHA, skipStaging: true }).filter(({ args }) => args.includes("pages") && args.includes("deploy")).length, 1);
});

test("resolves local Turbo cache overrides inside the main checkout", () => {
  assert.equal(resolveTurboCacheDirectory({ mainCheckoutRoot: "/repo", environment: {} }), "/repo/.turbo/cache");
  assert.equal(resolveTurboCacheDirectory({ mainCheckoutRoot: "/repo", environment: { CHALK_WEB_TURBO_CACHE_DIR: "   " } }), "/repo/.turbo/cache");
  assert.equal(resolveTurboCacheDirectory({ mainCheckoutRoot: "/repo", environment: { CHALK_WEB_TURBO_CACHE_DIR: " .cache/web " } }), "/repo/.cache/web");
  assert.throws(() => resolveTurboCacheDirectory({ mainCheckoutRoot: "/repo", environment: { CHALK_WEB_TURBO_CACHE_DIR: "../shared-cache" } }), /inside the main checkout/);
  assert.throws(() => resolveTurboCacheDirectory({ mainCheckoutRoot: "/repo", environment: { CHALK_WEB_TURBO_CACHE_DIR: "~/shared-cache" } }), /inside the main checkout/);
  assert.throws(() => resolveTurboCacheDirectory({ mainCheckoutRoot: "/repo", environment: { CHALK_WEB_TURBO_CACHE_DIR: "." } }), /inside the main checkout/);
});

test("keeps release environment hashes on the web task and excludes credentials", async () => {
  const turbo = JSON.parse(await readFile(new URL("../../turbo.json", import.meta.url), "utf8"));
  assert.deepEqual(turbo.tasks.build.env, ["DATABASE_URL", "API_URL", "CHALK_APP_VARIANT", "EAS_BUILD_PROFILE", "EXPO_PUBLIC_*"]);
  assert.deepEqual(turbo.tasks["web#build"].env, [
    "API_URL",
    "DATABASE_URL",
    "CHALK_COMMIT_SHA",
    "CHALK_ENVIRONMENT",
    "CHALK_EPISODE_DIAGNOSTICS",
    "CHALK_EPISODE_DIAGNOSTICS_GATEWAY",
    "CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN",
    "CHALK_API_URL",
    "CHALK_DEV_API_ORIGIN",
    "CHALK_DEV_WEB_PORT",
    "GITHUB_SHA",
    "VITE_*",
  ]);
  assert.equal(turbo.tasks.build.env.includes("CLOUDFLARE_API_TOKEN"), false);
  assert.equal(turbo.tasks["web#build"].env.includes("CLOUDFLARE_API_TOKEN"), false);
  assert.deepEqual(turbo.tasks["web#build"].passThroughEnv, ["CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN"]);
  assert.equal(turbo.tasks["web#build"].passThroughEnv.includes("CLOUDFLARE_API_TOKEN"), false);
});

test("passes the main checkout cache to detached local release builds", async () => {
  const calls = [];
  const lockDirectory = await mkdtemp(join(tmpdir(), "chalk-web-release-cache-lock-test-"));
  temporaryDirectories.push(lockDirectory);
  const cacheDirectory = join(lockDirectory, "turbo-cache");
  const commandRunner = createReleaseCommandRunner({ calls, stagingOutput: "https://abc123.chalk-staging.pages.dev" });

  await runLocalWebRelease({
    arguments_: ["--sha", fullSHA],
    environment: { CLOUDFLARE_API_TOKEN: "injected-by-test", CHALK_WEB_TURBO_CACHE_DIR: cacheDirectory },
    commandRunner,
    rootDirectory: lockDirectory,
    lockPath: join(lockDirectory, "release.lock"),
  });

  const build = calls.find(({ command, args }) => command === "pnpm" && args.includes("run") && args.includes("build"));
  assert.ok(build);
  assert.equal(build.args.at(-2), "--cache-dir");
  assert.equal(build.args.at(-1), cacheDirectory);
  assert.notEqual(build.cwd, lockDirectory);
  assert.ok(build.cwd.endsWith("/checkout"));
  assert.equal(calls.filter(({ args }) => args.includes("pages") && args.includes("deploy")).length, 2);
});

test("runs one build, both uploads, and both verifiers through structured commands", async () => {
  const calls = await runRecordedWebRelease();

  const installs = calls.filter(({ command, args }) => command === "pnpm" && args[0] === "install");
  const builds = calls.filter(({ command, args }) => command === "pnpm" && args.includes("run") && args.includes("build"));
  const uploads = calls.filter(({ args }) => args.includes("pages") && args.includes("deploy"));
  const verifications = calls.filter(({ args }) => args.some((argument) => argument.endsWith("verify-web-deploy.mjs")));
  assert.equal(installs.length, 1);
  assert.equal(builds.length, 1);
  assert.equal(builds[0].env.CHALK_COMMIT_SHA, fullSHA);
  assert.equal(builds[0].env.CHALK_ENVIRONMENT, "production");
  assert.equal(uploads.length, 2);
  assert.equal(verifications.length, 2);
  assert.ok(uploads.every(({ cwd }) => cwd === "/repo/apps/web"));
  assert.equal(verifications[0].args.at(-1), fullSHA);
  assert.equal(verifications[1].args.at(-1), "--production");
});

test("reads the pinned Wrangler version only after the workspace install", async () => {
  const calls = await runRecordedWebRelease();

  const order = calls.map(serializeReleaseCommand).filter((command) => command === installCommand || command === wranglerVersionCommand);
  assert.deepEqual(order, [installCommand, wranglerVersionCommand]);
});
