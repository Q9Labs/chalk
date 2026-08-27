import { pathToFileURL } from "node:url";

const DEFAULT_DEADLINE_MS = 90_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DIAGNOSTICS_PROBE_PATH = "/_internal/episode-diagnostics/chalkdiag%3Av1%3Aproduction%3Adiag01";
const DIAGNOSTICS_DOCUMENT_PROBE_PATH = "/developer/episode-diagnostics/chalk.episode%3A00000000-0000-4000-8000-000000000001";

export async function verifyWebDeploy({ baseURL, expectedSHA, deadlineMs = DEFAULT_DEADLINE_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const origin = normalizeBaseURL(baseURL);
  const normalizedSHA = normalizeSHA(expectedSHA);
  const deadline = Date.now() + deadlineMs;
  let attempt = 0;
  let lastError;

  while (Date.now() <= deadline) {
    attempt += 1;
    try {
      await verifyOnce(origin, normalizedSHA, requestTimeoutMs);
      console.log(`Web deployment verified at ${origin.origin} on attempt ${attempt}.`);
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() + retryDelayMs > deadline) break;
      console.warn(`Verification attempt ${attempt} failed: ${errorMessage(error)}. Retrying...`);
      await delay(retryDelayMs);
    }
  }

  throw new Error(`Web deployment verification failed at ${origin.origin} after ${attempt} attempts: ${errorMessage(lastError)}`);
}

export function parseArguments(arguments_) {
  const production = arguments_.includes("--production");
  const positional = arguments_.filter((argument) => argument !== "--production");
  if (positional.length !== 2 || arguments_.some((argument) => argument.startsWith("--") && argument !== "--production")) {
    throw new Error("Usage: node scripts/deploy/verify-web-deploy.mjs <base-url> <expected-sha> [--production]");
  }

  return { baseURL: positional[0], expectedSHA: normalizeSHA(positional[1]), production };
}

async function verifyOnce(baseURL, expectedSHA, requestTimeoutMs) {
  await verifyServiceWorker(baseURL, expectedSHA, requestTimeoutMs);
  await verifyBoundaryHealth(baseURL, requestTimeoutMs);
  await verifyDiagnosticsGateway(baseURL, requestTimeoutMs);
  await verifyDiagnosticsDocument(baseURL, requestTimeoutMs);
}

async function verifyServiceWorker(baseURL, expectedSHA, requestTimeoutMs) {
  const serviceWorkerURL = endpointURL(baseURL, "/sw.js");
  serviceWorkerURL.searchParams.set("cb", expectedSHA);
  const serviceWorker = await request(serviceWorkerURL, requestTimeoutMs);
  requireStatus(serviceWorker, 200, "service worker");
  const serviceWorkerSource = await serviceWorker.text();
  const deployedSHA = serviceWorkerSource.match(/"commitHash"\s*:\s*"([0-9a-f]{40})"/i)?.[1]?.toLowerCase();
  if (deployedSHA !== expectedSHA) {
    throw new Error(`service worker has commit ${deployedSHA ?? "unknown"}, expected ${expectedSHA}`);
  }
}

async function verifyBoundaryHealth(baseURL, requestTimeoutMs) {
  const boundaryHealth = await request(endpointURL(baseURL, "/api/healthz"), requestTimeoutMs);
  requireStatus(boundaryHealth, 200, "account boundary health");
  const health = await readJSON(boundaryHealth, "account boundary health");
  const { status, dependencies = {} } = health ?? {};
  if (status !== "ok" || dependencies.account_api !== "ok") {
    throw new Error("account boundary health did not report healthy dependencies");
  }
}

async function verifyDiagnosticsGateway(baseURL, requestTimeoutMs) {
  const diagnosticsGateway = await request(endpointURL(baseURL, DIAGNOSTICS_PROBE_PATH), requestTimeoutMs);
  requireStatus(diagnosticsGateway, 401, "Episode Diagnostics gateway unauthenticated probe");
}

async function verifyDiagnosticsDocument(baseURL, requestTimeoutMs) {
  const diagnosticsDocument = await request(endpointURL(baseURL, DIAGNOSTICS_DOCUMENT_PROBE_PATH), requestTimeoutMs, "text/html");
  requireStatus(diagnosticsDocument, 200, "Episode Diagnostics document deep link");
  if (!diagnosticsDocument.headers.get("content-type")?.startsWith("text/html")) {
    throw new Error("Episode Diagnostics document deep link did not return HTML");
  }
}

async function request(url, timeoutMs, accept = "application/json") {
  return fetch(url, {
    cache: "no-store",
    headers: { Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function requireStatus(response, expectedStatus, checkName) {
  if (response.status !== expectedStatus) {
    throw new Error(`${checkName} returned ${response.status}, expected ${expectedStatus}`);
  }
}

async function readJSON(response, checkName) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${checkName} did not return JSON`);
  }
}

function normalizeBaseURL(rawURL) {
  const url = parseBaseURL(rawURL);
  if (!isBaseOrigin(url)) throw new Error(`Base URL must be an HTTPS origin: ${rawURL}`);
  return url;
}

function parseBaseURL(rawURL) {
  let url;
  try {
    url = new URL(rawURL);
  } catch {
    throw new Error(`Invalid base URL: ${rawURL}`);
  }
  return url;
}

function isBaseOrigin(url) {
  const hasExtraParts = [url.username, url.password, url.search, url.hash].some(Boolean) || url.pathname !== "/";
  return !hasExtraParts && isAllowedProtocol(url);
}

function isAllowedProtocol(url) {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
}

function normalizeSHA(rawSHA) {
  const sha = rawSHA?.trim().toLowerCase();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid commit SHA: ${rawSHA}`);
  return sha;
}

function endpointURL(baseURL, pathname) {
  return new URL(pathname, baseURL);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  verifyWebDeploy(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
