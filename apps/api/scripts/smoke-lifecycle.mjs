#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDir, "..");
const toolchain = process.env.CHALK_API_GOTOOLCHAIN || "go1.25.11+auto";
const commandEnv = withGoPath({ ...process.env, GOTOOLCHAIN: toolchain });
const startupBudgetMs = numberFromEnv("CHALK_API_LIFECYCLE_STARTUP_BUDGET_MS", 3000);
const shutdownBudgetMs = numberFromEnv("CHALK_API_LIFECYCLE_SHUTDOWN_BUDGET_MS", 3000);

const tmp = await mkdtemp(join(tmpdir(), "chalk-api-lifecycle-"));
const binary = join(tmp, "chalk-api");
const serverLog = join(tmp, "server.log");

let serverProcess;
let serverExit;
let logFd;

try {
  await run("go", ["build", "-o", binary, "./cmd"], {
    cwd: apiRoot,
    env: commandEnv,
  });

  const addr = process.env.CHALK_API_LIFECYCLE_ADDR || `127.0.0.1:${await freePort()}`;
  const baseURL = `http://${addr}`;

  logFd = openSync(serverLog, "w");
  const startedAt = Date.now();

  serverProcess = spawn(binary, [], {
    cwd: apiRoot,
    env: { ...commandEnv, CHALK_API_ADDR: addr },
    stdio: ["ignore", logFd, logFd],
  });

  serverProcess.on("exit", (code, signal) => {
    serverExit = { code, signal };
  });

  serverProcess.on("error", (error) => {
    fail(`failed to start API binary: ${error.message}`);
  });

  await waitForHealth(baseURL, startupBudgetMs);
  const startupMs = Date.now() - startedAt;

  const shutdownStartedAt = Date.now();
  serverProcess.kill("SIGTERM");
  const exit = await waitForExit(shutdownBudgetMs);
  const shutdownMs = Date.now() - shutdownStartedAt;

  if (exit.code !== 0) {
    fail(`API exited with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}`);
  }

  console.log(
    `API lifecycle smoke test passed: startup ${startupMs}ms, shutdown ${shutdownMs}ms ` +
      `(budgets: startup ${startupBudgetMs}ms, shutdown ${shutdownBudgetMs}ms)`,
  );
} finally {
  if (serverProcess && !serverExit) {
    serverProcess.kill("SIGKILL");
  }
  if (logFd !== undefined) {
    closeSync(logFd);
  }
  await rm(tmp, { recursive: true, force: true });
}

function withGoPath(env) {
  const goBin = "/usr/local/go/bin";
  const path = env.PATH || "";

  if (path.split(":").includes(goBin)) {
    return env;
  }

  return { ...env, PATH: path ? `${goBin}:${path}` : goBin };
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }

  return parsed;
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });
  });
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();

    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("could not allocate a TCP port"));
        return;
      }

      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(baseURL, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";

  while (Date.now() < deadline) {
    if (serverExit) {
      fail(`API exited before becoming ready with code ${serverExit.code ?? "null"} signal ${serverExit.signal ?? "null"}`);
    }

    try {
      const response = await fetch(`${baseURL}/healthz`, { signal: AbortSignal.timeout(250) });
      if (response.status === 200) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(25);
  }

  fail(`API did not accept GET /healthz within ${timeoutMs}ms; last result: ${lastError}`);
}

async function waitForExit(timeoutMs) {
  if (serverExit) return serverExit;

  const timeout = new Promise((_, rejectTimeout) => {
    setTimeout(() => rejectTimeout(new Error(`API did not exit within ${timeoutMs}ms after SIGTERM`)), timeoutMs);
  });

  await Promise.race([once(serverProcess, "exit"), timeout]);
  return serverExit;
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function fail(message) {
  console.error(message);

  try {
    const log = readFileSync(serverLog, "utf8");
    if (log.trim()) {
      console.error("\nAPI log:");
      console.error(log);
    }
  } catch {
    // Best-effort diagnostics only.
  }

  process.exit(1);
}
