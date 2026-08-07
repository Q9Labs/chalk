#!/usr/bin/env node
// @ts-check

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDiagnosticFixtureServer, VISUAL_VIEWPORTS } from "./fixture-server.mjs";
import { runEpisodeDiagnosticBrowserProof } from "./browser-proof.mjs";
import { VISUAL_STATES } from "./visual-matrix.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const WEB_ROOT = resolve(REPOSITORY_ROOT, "apps/web");
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

/**
 * Start the loopback API fixture and the real apps/web Vite process, then run
 * the URL-template browser matrix against the mounted developer route. The
 * fixture server is only an API dependency; the browser always navigates to
 * the real web application.
 *
 * @param {{ browser?: any; browserOptions?: Record<string, unknown>; fixturePort?: number; webPort?: number; operatorCredential?: string; outputDir?: string; screenshot?: boolean; states?: readonly string[]; viewports?: readonly number[]; timeoutMs?: number }} [options]
 */
export async function runLocalEpisodeDiagnosticBrowserProof(options = {}) {
  const config = await resolveLocalProofConfig(options);
  const resources = await createLocalProofResources(config);
  const { result, failure } = await attemptLocalProof(config, resources);
  const cleanupErrors = await cleanupLocalProof(resources);
  return finalizeLocalProof(result, failure, cleanupErrors, resources.fixture.url, config);
}

/** @param {any} config @param {any} resources */
async function attemptLocalProof(config, resources) {
  try {
    return { result: await executeLocalProof(config, resources), failure: undefined };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    appendWebDiagnostics(failure, resources.webProcess);
    return { result: undefined, failure };
  }
}

/** @param {any} result @param {Error|undefined} failure @param {Error[]} cleanupErrors @param {string} fixtureUrl @param {any} config */
function finalizeLocalProof(result, failure, cleanupErrors, fixtureUrl, config) {
  if (failure) {
    appendCleanupDiagnostics(failure, cleanupErrors);
    throw failure;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Local Episode Diagnostics browser proof cleanup failed");
  return { ...result, fixtureUrl, webOrigin: config.webOrigin, debuggerUrl: config.debuggerUrl, states: [...config.states], viewports: [...config.viewports] };
}

/** @param {any} options */
async function resolveLocalProofConfig(options) {
  const fixturePort = await resolvePort(options.fixturePort);
  const webPort = await resolvePort(options.webPort);
  assertPort(fixturePort, "fixturePort");
  assertPort(webPort, "webPort");
  if (fixturePort === webPort) throw new Error("The fixture and Vite proof ports must be different");
  const credential = defaultOption(options.operatorCredential, `fixture-${randomBytes(18).toString("base64url")}`);
  return {
    fixturePort,
    webPort,
    credential,
    readyTimeoutMs: defaultOption(options.timeoutMs, DEFAULT_READY_TIMEOUT_MS),
    outputDir: options.outputDir,
    states: defaultOption(options.states, VISUAL_STATES),
    viewports: defaultOption(options.viewports, VISUAL_VIEWPORTS),
    browser: options.browser,
    browserOptions: options.browserOptions,
    screenshot: options.screenshot,
    webOrigin: `http://127.0.0.1:${webPort}`,
    debuggerUrl: `http://127.0.0.1:${webPort}/developer/episode-diagnostics/{reference}`,
  };
}

/** @param {number|undefined} port */
async function resolvePort(port) {
  if (port == null) return availableLoopbackPort();
  return port;
}

/** @param {any} value @param {any} fallback */
function defaultOption(value, fallback) {
  return value ?? fallback;
}

/** @param {any} config */
async function createLocalProofResources(config) {
  const fixture = await createDiagnosticFixtureServer({ host: "127.0.0.1", port: config.fixturePort, operatorCredential: config.credential });
  return { fixture, webOrigin: config.webOrigin, webProcess: undefined, browser: config.browser, ownsBrowser: false };
}

/** @param {any} config @param {any} resources */
async function executeLocalProof(config, resources) {
  resources.webProcess = startWebProcess({ webPort: config.webPort, fixturePort: config.fixturePort, credential: config.credential });
  await waitForWeb(config.webOrigin, resources.webProcess, config.readyTimeoutMs);
  await ensureBrowser(config, resources);
  return runEpisodeDiagnosticBrowserProof({ debuggerUrl: config.debuggerUrl, browser: resources.browser, environment: "localhost", outputDir: config.outputDir, screenshot: config.screenshot, states: config.states, viewports: config.viewports });
}

/** @param {any} config @param {any} resources */
async function ensureBrowser(config, resources) {
  if (resources.browser) return;
  const { chromium } = await import("playwright");
  resources.browser = await chromium.launch({ headless: true, ...defaultBrowserExecutable(), ...(config.browserOptions ?? {}) });
  resources.ownsBrowser = true;
}

/** @param {Error} failure @param {any} webProcess */
function appendWebDiagnostics(failure, webProcess) {
  const webOutput = webProcess?.diagnosticsOutput?.().trim();
  if (webOutput) failure.message = `${failure.message}; Vite output: ${webOutput}`;
}

/** @param {Error} failure @param {Error[]} cleanupErrors */
function appendCleanupDiagnostics(failure, cleanupErrors) {
  if (cleanupErrors.length === 0) return;
  failure.message = `${failure.message}; cleanup: ${cleanupErrors.map((error) => error.message).join("; ")}`;
}

/** @param {any} resources */
async function cleanupLocalProof(resources) {
  const cleanupErrors = [];
  const browserError = await cleanupBrowser(resources);
  if (browserError) cleanupErrors.push(browserError);
  const webError = await cleanupWeb(resources);
  if (webError) cleanupErrors.push(webError);
  const fixtureError = await cleanupFixture(resources);
  if (fixtureError) cleanupErrors.push(fixtureError);
  return cleanupErrors;
}

/** @param {any} resources */
async function cleanupBrowser(resources) {
  if (!resources.ownsBrowser) return undefined;
  if (!resources.browser) return undefined;
  try {
    await resources.browser.close();
    return undefined;
  } catch (error) {
    return cleanupError("Browser", error);
  }
}

/** @param {any} resources */
async function cleanupWeb(resources) {
  if (!resources.webProcess) return undefined;
  try {
    await stopProcess(resources.webProcess, DEFAULT_STOP_TIMEOUT_MS);
    await waitForPortClosed(resources.webOrigin, DEFAULT_STOP_TIMEOUT_MS);
    return undefined;
  } catch (error) {
    return cleanupError("Vite", error);
  }
}

/** @param {any} resources */
async function cleanupFixture(resources) {
  try {
    await resources.fixture.close();
    return undefined;
  } catch (error) {
    return cleanupError("Fixture", error);
  }
}

/** @param {string} label @param {unknown} error */
function cleanupError(label, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${label} cleanup failed: ${message}`);
}

/** @param {{ webPort: number; fixturePort: number; credential: string }} options */
function startWebProcess(options) {
  const child = spawn("pnpm", ["exec", "vite", "dev", "--host", "127.0.0.1", "--port", String(options.webPort)], {
    cwd: WEB_ROOT,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      CHALK_DEV_WEB_PORT: String(options.webPort),
      CHALK_EPISODE_DIAGNOSTICS: "localhost",
      CHALK_ENVIRONMENT: "localhost",
      CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN: options.credential,
      CHALK_API_URL: `http://127.0.0.1:${options.fixturePort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError;
  const capture = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-8_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("error", (error) => {
    spawnError = error;
  });
  child.diagnosticsOutput = () => output.replaceAll(options.credential, "[redacted]");
  child.spawnError = () => spawnError;
  return child;
}

function defaultBrowserExecutable() {
  if (process.env.CHALK_EPISODE_DIAGNOSTICS_BROWSER?.trim()) return { executablePath: process.env.CHALK_EPISODE_DIAGNOSTICS_BROWSER.trim() };
  const candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Helium.app/Contents/MacOS/Helium", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  return executablePath ? { executablePath } : {};
}

/** @param {import("node:child_process").ChildProcess} child @param {number} timeoutMs */
async function waitForWeb(origin, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertWebProcessReady(child);
    const response = await fetchWebOrigin(origin);
    if (await waitForWebResponse(response)) return;
  }
  throw new Error(`Vite did not become ready within ${timeoutMs}ms: ${processDiagnostics(child)}`);
}

/** @param {Response|undefined} response */
async function waitForWebResponse(response) {
  if (!response) {
    await delay(250);
    return false;
  }
  if (response.ok) return true;
  await assertWebResponse(response);
  await delay(250);
  return false;
}

/** @param {import("node:child_process").ChildProcess} child */
function assertWebProcessReady(child) {
  const spawnError = readProcessError(child);
  if (spawnError) throw new Error(`Could not start Vite: ${spawnError.message}`);
  if (child.exitCode !== null) throw new Error(`Vite exited before readiness (${child.exitCode}): ${processDiagnostics(child)}`);
}

/** @param {any} child */
function readProcessError(child) {
  if (typeof child.spawnError !== "function") return undefined;
  return child.spawnError();
}

/** @param {any} child */
function processDiagnostics(child) {
  if (typeof child.diagnosticsOutput !== "function") return "no output";
  const output = child.diagnosticsOutput();
  return output ?? "no output";
}

/** @param {string} origin */
async function fetchWebOrigin(origin) {
  try {
    return await fetch(`${origin}/`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    // Vite is still compiling or binding its port.
    return undefined;
  }
}

/** @param {Response} response */
async function assertWebResponse(response) {
  if (response.status < 500) return;
  const body = (await response.text()).replace(/\s+/gu, " ").slice(0, 1_000);
  throw new Error(`Vite returned HTTP ${response.status} during readiness: ${body}`);
}

/** @param {import("node:child_process").ChildProcess} child @param {number} timeoutMs */
async function stopProcess(child, timeoutMs) {
  if (processExists(child)) signalProcess(child, "SIGTERM");
  await waitForExit(child, timeoutMs);
  if (processExists(child)) {
    signalProcess(child, "SIGKILL");
    await waitForExit(child, timeoutMs);
  }
  if (processExists(child)) throw new Error("Vite process did not exit after SIGTERM/SIGKILL");
}

/** @param {import("node:child_process").ChildProcess} child @param {NodeJS.Signals} signal */
function signalProcess(child, signal) {
  try {
    sendProcessSignal(child, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/** @param {import("node:child_process").ChildProcess} child @param {NodeJS.Signals} signal */
function sendProcessSignal(child, signal) {
  if (process.platform !== "win32" && child.pid) return process.kill(-child.pid, signal);
  return child.kill(signal);
}

/** @param {import("node:child_process").ChildProcess} child @param {number} timeoutMs */
async function waitForExit(child, timeoutMs) {
  if (!processExists(child)) return;
  await Promise.race([onceExit(child), delay(timeoutMs)]);
}

/** @param {import("node:child_process").ChildProcess} child */
function onceExit(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

/** @param {import("node:child_process").ChildProcess} child */
function processExists(child) {
  if (child.exitCode !== null) return false;
  if (!child.pid) return false;
  return canSignalProcess(child.pid);
}

/** @param {number} pid */
function canSignalProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** @param {string} origin @param {number} timeoutMs */
async function waitForPortClosed(origin, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(`${origin}/`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error(`Listener remained reachable at ${origin}`);
}

/** @returns {Promise<number>} */
async function availableLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolvePromise, reject) => {
    server.once("listening", resolvePromise);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port");
  const port = address.port;
  await new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return port;
}

/** @param {number} value @param {string} label */
function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${label} must be a valid TCP port`);
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  runLocalEpisodeDiagnosticBrowserProof({ outputDir: `.private/chalk-dev/episode-diagnostics-proofs/${timestamp}`, screenshot: true })
    .then((result) => process.stdout.write(`${JSON.stringify({ status: "passed", debuggerUrl: result.debuggerUrl, states: result.states.length, viewports: result.viewports, captures: result.results.length })}\n`))
    .catch((error) => {
      process.stderr.write(`Local Episode Diagnostics browser proof failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

export { assertPort, availableLoopbackPort, waitForPortClosed };
