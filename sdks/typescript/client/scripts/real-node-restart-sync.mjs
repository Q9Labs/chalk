import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../../..");
const syncDirectory = join(repositoryDirectory, "apps/sync");
const workerPath = join(packageDirectory, "scripts", "node-restart-sync-worker.mjs");
const fixturePrefix = "CHALK_SYNC_BROWSER_FIXTURE=";
const fixtureTimeoutMs = 30_000;

await run();

async function run() {
  const fixture = await startFixture(requiredDatabaseUrl());
  const pendingDirectory = await mkdtemp(join(tmpdir(), "chalk-sync-node-restart-"));
  const pendingStorePath = join(pendingDirectory, "pending.json");

  try {
    const config = await fixture.ready;
    assertLocalhostWebSocketUrl(config.url);

    await stageAndKillWorker(config, pendingStorePath);
    const staged = await readPendingCommands(pendingStorePath);
    if (staged.length !== 1 || staged[0]?.command?.name !== "set_hand_raised" || staged[0]?.command?.payload?.raised !== true || staged[0]?.bytes <= 0) {
      throw new Error("first Node process did not durably stage exactly one v3 set_hand_raised target");
    }

    const resumed = await runWorker("resume", config, pendingStorePath);
    if (resumed.revision !== 2 || resumed.pending !== 0) {
      throw new Error("restarted Node process did not converge the persisted command");
    }

    const remaining = await readPendingCommands(pendingStorePath);
    if (remaining.length !== 0) {
      throw new Error("restarted Node process did not remove the committed pending command");
    }

    console.log(`node-restart sync proof passed: url=${config.url} revision=${resumed.revision}`);
  } finally {
    await rm(pendingDirectory, { force: true, recursive: true });
    await fixture.stop();
  }
}

function requiredDatabaseUrl() {
  const url = process.env.CHALK_SYNC_TEST_DATABASE_URL ?? process.env.CHALK_DATABASE_URL;
  if (!url) {
    throw new Error("set CHALK_SYNC_TEST_DATABASE_URL to run the Postgres-backed Node restart sync proof");
  }
  return url;
}

function assertLocalhostWebSocketUrl(value) {
  const url = new URL(value);
  const localhost = new Set(["127.0.0.1", "localhost", "[::1]"]);

  if (url.protocol !== "ws:" || !localhost.has(url.hostname) || url.pathname !== "/v3/sync") {
    throw new Error("node-restart sync proof only connects to an explicit ws://localhost/v3/sync URL");
  }
}

async function startFixture(databaseUrl) {
  const child = spawn("mix", ["run", "--no-start", "test/support/browser/real_browser_fixture.exs"], {
    cwd: syncDirectory,
    env: { ...process.env, MIX_ENV: "test", CHALK_SYNC_TEST_DATABASE_URL: databaseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = readFixture(child);

  return {
    ready,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.stdin.end("\n");
      await waitForExit(child, 10_000);
    },
  };
}

function readFixture(child) {
  return new Promise((resolveFixture, rejectFixture) => {
    let output = "";
    let settled = false;
    let timeout;
    const settle = (callback) => (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const resolveReady = settle(resolveFixture);
    const rejectReady = settle(rejectFixture);

    timeout = setTimeout(() => rejectReady(new Error("timed out waiting for the local sync Node fixture")), fixtureTimeoutMs);
    child.once("error", (error) => rejectReady(error));
    child.once("exit", (code) => rejectReady(new Error(`local sync Node fixture exited before readiness (code ${code ?? "signal"})`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split("\n");
      output = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith(fixturePrefix)) {
          continue;
        }
        try {
          const fixture = JSON.parse(line.slice(fixturePrefix.length));
          if (typeof fixture.url !== "string" || typeof fixture.token !== "string") {
            throw new TypeError("fixture did not provide a WebSocket URL and token");
          }
          resolveReady(fixture);
        } catch (error) {
          rejectReady(error);
        }
      }
    });
    child.stderr.resume();
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = once(child, "exit");
  const timedOut = new Promise((resolveTimeout) => {
    setTimeout(resolveTimeout, timeoutMs);
  });

  if (await Promise.race([exited.then(() => true), timedOut.then(() => false)])) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function runWorker(action, config, pendingStorePath) {
  const child = spawnWorker(action, config, pendingStorePath);
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "exit");

  if (code !== 0) {
    throw new Error(`Node restart worker ${action} failed: ${stderr.join("").trim() || stdout.join("").trim()}`);
  }

  try {
    return JSON.parse(stdout.join(""));
  } catch {
    throw new Error(`Node restart worker ${action} did not return JSON`);
  }
}

async function stageAndKillWorker(config, pendingStorePath) {
  const child = spawnWorker("stage", config, pendingStorePath);
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  try {
    await waitForWorkerOutput(child, stdout, stderr, "stage");
    child.kill("SIGKILL");
    const [, signal] = await once(child, "exit");
    if (signal !== "SIGKILL") {
      throw new Error(`Node restart worker stage was not killed at the process boundary (signal ${signal ?? "none"})`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function spawnWorker(action, config, pendingStorePath) {
  return spawn(process.execPath, [workerPath, action], {
    env: {
      ...process.env,
      CHALK_SYNC_BROWSER_TOKEN: config.token,
      CHALK_SYNC_BROWSER_URL: config.url,
      CHALK_SYNC_PENDING_STORE_PATH: pendingStorePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForWorkerOutput(child, stdout, stderr, action) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !stdout.join("").includes("\n") && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!stdout.join("").includes("\n")) {
    throw new Error(`Node restart worker ${action} did not stage before exit: ${stderr.join("").trim() || stdout.join("").trim()}`);
  }
}

async function readPendingCommands(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) {
      throw new TypeError("pending command file is not an array");
    }
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
