import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "../..");
export const webDirectory = join(repositoryRoot, "apps/web");
export const verifierPath = join(repositoryRoot, "scripts/deploy/verify-web-deploy.mjs");

export const RELEASE_TOOL_VERSIONS = Object.freeze({
  minimumNodeMajor: 22,
  pnpm: "10.26.2",
  wrangler: "4.107.0",
});

export const DEFAULT_PRODUCTION_URL = "https://chalkmeet.com";
export const STAGING_PROJECT = "chalk-staging";
export const PRODUCTION_PROJECT = "chalk";
export const DEFAULT_RELEASE_LOCK_PATH = join(tmpdir(), "chalk-web-release.lock");

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function normalizeSHA(rawSHA) {
  const sha = rawSHA?.trim();
  if (!sha || !SHA_PATTERN.test(sha)) {
    throw new Error(`Expected a full 40-character lowercase commit SHA, received: ${rawSHA ?? ""}`);
  }
  return sha;
}

export function parseArguments(arguments_, { isCI = false } = {}) {
  let sha;
  let skipStaging = false;
  let dryRun = false;
  let recoverStaleLock = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--" && index === 0) {
      continue;
    }
    if (argument === "--sha") {
      if (sha !== undefined || index + 1 >= arguments_.length) throw usageError();
      sha = normalizeSHA(arguments_[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--sha=")) {
      if (sha !== undefined) throw usageError();
      sha = normalizeSHA(argument.slice("--sha=".length));
      continue;
    }
    if (argument === "--skip-staging") {
      if (skipStaging) throw usageError();
      skipStaging = true;
      continue;
    }
    if (argument === "--dry-run") {
      if (dryRun) throw usageError();
      dryRun = true;
      continue;
    }
    if (argument === "--recover-stale-lock") {
      if (recoverStaleLock) throw usageError();
      recoverStaleLock = true;
      continue;
    }
    throw usageError();
  }

  if (isCI && sha === undefined) {
    throw new Error("--sha <40-character SHA> is required in CI");
  }
  if (isCI && recoverStaleLock) {
    throw new Error("--recover-stale-lock is only available for local releases");
  }
  return { sha, skipStaging, dryRun, recoverStaleLock };
}

export function parseDeploymentURL(output, projectName = STAGING_PROJECT) {
  const projectPattern = escapeRegExp(projectName);
  const match = String(output ?? "").match(new RegExp(`https://[a-z0-9-]+\\.${projectPattern}\\.pages\\.dev(?:/)?`, "i"));
  if (!match) {
    throw new Error(`Wrangler did not print a ${projectName}.pages.dev deployment URL`);
  }
  return new URL(match[0]).origin;
}

export function buildReleasePlan({ sha, skipStaging = false, productionURL = DEFAULT_PRODUCTION_URL, rootDirectory = repositoryRoot, webPath = webDirectory, verifier = verifierPath }) {
  const normalizedSHA = normalizeSHA(sha);
  const commands = [commandSpec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], rootDirectory), commandSpec("pnpm", ["exec", "turbo", "run", "build", "--filter=web..."], rootDirectory)];

  if (!skipStaging) {
    commands.push(
      commandSpec("pnpm", ["exec", "wrangler", "pages", "deploy", "dist/client", "--project-name", STAGING_PROJECT, "--branch", "staging", "--commit-hash", normalizedSHA, "--commit-dirty=false"], webPath),
      commandSpec(process.execPath, [verifier, "<staging-url>", normalizedSHA], rootDirectory),
    );
  }

  commands.push(
    commandSpec("pnpm", ["exec", "wrangler", "pages", "deploy", "dist/client", "--project-name", PRODUCTION_PROJECT, "--branch", "master", "--commit-hash", normalizedSHA, "--commit-dirty=false"], webPath),
    commandSpec(process.execPath, [verifier, productionURL, normalizedSHA, "--production"], rootDirectory),
  );
  return commands;
}

export async function runWebRelease({ arguments_ = process.argv.slice(2), environment = process.env, commandRunner = runCommand, rootDirectory = repositoryRoot, webPath = webDirectory, productionURL = environment.CHALK_WEB_PRODUCTION_URL?.trim() || DEFAULT_PRODUCTION_URL, build = true } = {}) {
  const executionEnvironment = { ...process.env, ...environment };
  const isCI = executionEnvironment.CI === "true" || executionEnvironment.GITHUB_ACTIONS === "true";
  const options = parseArguments(arguments_, { isCI });
  const currentSHA = await readGitSHA(commandRunner, rootDirectory, executionEnvironment);
  const expectedSHA = options.sha ?? currentSHA;
  assertExactHEAD(currentSHA, expectedSHA);
  await assertCleanTree(commandRunner, rootDirectory, executionEnvironment);

  const releasePlan = buildReleasePlan({ sha: expectedSHA, skipStaging: options.skipStaging, productionURL, rootDirectory, webPath });
  if (options.dryRun) {
    printDryRun(expectedSHA, releasePlan);
    return { sha: expectedSHA, dryRun: true, plan: releasePlan };
  }

  await checkRuntimeTools(commandRunner, rootDirectory, executionEnvironment);
  if (!executionEnvironment.CLOUDFLARE_API_TOKEN?.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN is required for a web release; inject it with op run locally or the CI secret");
  }

  await commandRunner(commandSpec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], rootDirectory, { env: executionEnvironment }));
  await checkPinnedWrangler(commandRunner, webPath, executionEnvironment);

  if (build) {
    const buildEnvironment = {
      ...executionEnvironment,
      CHALK_COMMIT_SHA: expectedSHA,
      CHALK_ENVIRONMENT: "production",
      CHALK_EPISODE_DIAGNOSTICS: "hosted",
      CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN: "true",
      CHALK_EPISODE_DIAGNOSTICS_GATEWAY: "verified",
      VITE_API_URL: "https://api.chalkmeet.com",
      VITE_CHALK_TELEMETRY_ENABLED: "false",
    };
    await commandRunner(commandSpec("pnpm", ["exec", "turbo", "run", "build", "--filter=web..."], rootDirectory, { env: buildEnvironment }));
  }

  let stagingURL;
  if (!options.skipStaging) {
    const stagingDeployment = await commandRunner(commandSpec("pnpm", ["exec", "wrangler", "pages", "deploy", "dist/client", "--project-name", STAGING_PROJECT, "--branch", "staging", "--commit-hash", expectedSHA, "--commit-dirty=false"], webPath, { capture: true, env: executionEnvironment }));
    stagingURL = parseDeploymentURL(combinedOutput(stagingDeployment), STAGING_PROJECT);
    await runVerifier(commandRunner, stagingURL, expectedSHA, executionEnvironment, rootDirectory);
  }

  await commandRunner(commandSpec("pnpm", ["exec", "wrangler", "pages", "deploy", "dist/client", "--project-name", PRODUCTION_PROJECT, "--branch", "master", "--commit-hash", expectedSHA, "--commit-dirty=false"], webPath, { env: executionEnvironment }));
  await runVerifier(commandRunner, productionURL, expectedSHA, executionEnvironment, rootDirectory, true);

  return { sha: expectedSHA, stagingURL, productionURL, dryRun: false, plan: releasePlan };
}

export const deployWebRelease = runWebRelease;

export async function runLocalWebRelease({ arguments_ = process.argv.slice(2), environment = process.env, commandRunner = runCommand, rootDirectory = repositoryRoot, lockPath = environment.CHALK_WEB_RELEASE_LOCK_PATH?.trim() || DEFAULT_RELEASE_LOCK_PATH } = {}) {
  const executionEnvironment = { ...process.env, ...environment };
  const options = parseArguments(arguments_);
  const expectedSHA = options.sha ?? (await readGitSHA(commandRunner, rootDirectory, executionEnvironment));

  if (options.dryRun) {
    const plan = buildReleasePlan({ sha: expectedSHA, skipStaging: options.skipStaging, productionURL: executionEnvironment.CHALK_WEB_PRODUCTION_URL?.trim() || DEFAULT_PRODUCTION_URL, rootDirectory, webPath: join(rootDirectory, "apps/web") });
    console.log(`Local web release dry-run for ${expectedSHA}; no detached worktree, install, upload, or verification commands were executed.`);
    printDryRun(expectedSHA, plan);
    return { sha: expectedSHA, dryRun: true, plan };
  }

  if (options.recoverStaleLock) {
    await recoverStaleReleaseLock(lockPath);
  }

  return withReleaseLock(lockPath, async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "chalk-web-release-"));
    const worktreePath = join(workspaceRoot, "checkout");
    let worktreeAdded = false;
    try {
      await commandRunner(commandSpec("git", ["worktree", "add", "--detach", worktreePath, expectedSHA], rootDirectory, { env: executionEnvironment }));
      worktreeAdded = true;
      const nestedArguments = ["--sha", expectedSHA, ...(options.skipStaging ? ["--skip-staging"] : [])];
      return await runWebRelease({
        arguments_: nestedArguments,
        environment: executionEnvironment,
        commandRunner,
        rootDirectory: worktreePath,
        webPath: join(worktreePath, "apps/web"),
      });
    } finally {
      try {
        if (worktreeAdded) {
          await commandRunner(commandSpec("git", ["worktree", "remove", "--force", worktreePath], rootDirectory, { env: executionEnvironment }));
        }
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }
  });
}

export async function withReleaseLock(lockPath, operation) {
  await acquireReleaseLock(lockPath);
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function recoverStaleReleaseLock(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    throw new Error(`Cannot safely recover release lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const ownerPID = owner?.pid;
  if (!Number.isInteger(ownerPID) || ownerPID <= 0) {
    throw new Error(`Cannot safely recover release lock ${lockPath}: owner PID is invalid`);
  }
  if (isProcessRunning(ownerPID)) {
    throw new Error(`Cannot recover release lock ${lockPath}: owner process ${ownerPID} is still running`);
  }

  await rm(lockPath, { recursive: true, force: false });
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function acquireReleaseLock(lockPath) {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Another web release is already running (lock: ${lockPath})`);
    throw new Error(`Unable to acquire web release lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await writeLockMetadata(lockPath);
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

async function writeLockMetadata(lockPath) {
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}

async function runVerifier(commandRunner, baseURL, expectedSHA, environment, rootDirectory, production = false) {
  const verifier = join(rootDirectory, "scripts/deploy/verify-web-deploy.mjs");
  await commandRunner(commandSpec(process.execPath, [verifier, baseURL, expectedSHA, ...(production ? ["--production"] : [])], rootDirectory, { env: environment }));
}

async function checkRuntimeTools(commandRunner, rootDirectory, environment) {
  const nodeVersion = commandOutput(await commandRunner(commandSpec("node", ["--version"], rootDirectory, { capture: true, env: environment })));
  assertMinimumNodeVersion(nodeVersion, RELEASE_TOOL_VERSIONS.minimumNodeMajor);

  const pnpmVersion = commandOutput(await commandRunner(commandSpec("pnpm", ["--version"], rootDirectory, { capture: true, env: environment })));
  assertToolVersion("pnpm", pnpmVersion, RELEASE_TOOL_VERSIONS.pnpm);
}

/** Wrangler ships as a workspace dependency, so a fresh CI checkout can only report it after the install. */
async function checkPinnedWrangler(commandRunner, webPath, environment) {
  const wranglerVersion = commandOutput(await commandRunner(commandSpec("pnpm", ["exec", "wrangler", "--version"], webPath, { capture: true, env: environment })));
  assertToolVersion("Wrangler", wranglerVersion, RELEASE_TOOL_VERSIONS.wrangler);
}

function assertMinimumNodeVersion(output, minimumMajor) {
  const match = output.trim().match(/^v?(\d+)\./);
  if (!match || Number(match[1]) < minimumMajor) {
    throw new Error(`node must be version ${minimumMajor} or newer; received ${output.trim() || "unknown"}`);
  }
}

function assertToolVersion(tool, output, expectedVersion) {
  const versionPattern = new RegExp(`(?:^|\\s)v?${escapeRegExp(expectedVersion)}(?:\\s|$)`);
  if (!versionPattern.test(output.trim())) {
    throw new Error(`${tool} must be pinned to ${expectedVersion}; received ${output.trim() || "unknown"}`);
  }
}

async function readGitSHA(commandRunner, rootDirectory, environment) {
  return normalizeSHA(commandOutput(await commandRunner(commandSpec("git", ["rev-parse", "HEAD"], rootDirectory, { capture: true, env: environment }))));
}

async function assertCleanTree(commandRunner, rootDirectory, environment) {
  const status = commandOutput(await commandRunner(commandSpec("git", ["status", "--porcelain=v1", "--untracked-files=all"], rootDirectory, { capture: true, env: environment })));
  if (status.trim()) throw new Error(`Release requires a clean worktree; changed paths:\n${status.trim()}`);
}

function assertExactHEAD(currentSHA, expectedSHA) {
  if (currentSHA !== expectedSHA) {
    throw new Error(`Release SHA ${expectedSHA} does not match HEAD ${currentSHA}`);
  }
}

function commandSpec(command, args, cwd, options = {}) {
  return { command, args, cwd, ...options };
}

function commandOutput(result) {
  return typeof result === "string" ? result : (result?.stdout ?? "");
}

function combinedOutput(result) {
  if (typeof result === "string") return result;
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

function printDryRun(expectedSHA, releasePlan) {
  console.log(`Web release dry-run for ${expectedSHA}; no build, upload, or verification commands were executed.`);
  for (const command of releasePlan) {
    console.log(`  ${command.command} ${command.args.join(" ")} (cwd: ${command.cwd})`);
  }
}

function usageError() {
  return new Error("Usage: pnpm run release:web [--sha <40-char-sha>] [--skip-staging] [--recover-stale-lock] [--dry-run]");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runCommand({ command, args, cwd, env = process.env, capture = false }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        process.stderr.write(chunk);
      });
    }
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  runReleaseCLI().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function runReleaseCLI() {
  const arguments_ = process.argv.slice(2);
  const environment = process.env;
  const isCI = environment.CI === "true" || environment.GITHUB_ACTIONS === "true";
  const options = parseArguments(arguments_, { isCI });
  if (options.dryRun) {
    if (isCI) return runWebRelease({ arguments_, environment });
    return runLocalWebRelease({ arguments_, environment });
  }

  if (!isCI) return runLocalWebRelease({ arguments_, environment });

  const lockPath = environment.CHALK_WEB_RELEASE_LOCK_PATH?.trim() || DEFAULT_RELEASE_LOCK_PATH;
  return withReleaseLock(lockPath, () => runWebRelease({ arguments_, environment }));
}
