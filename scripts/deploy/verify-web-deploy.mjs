import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_DEADLINE_MS = 90_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const APP_LINK_FILES = ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"];
const SMART_APP_BANNER = /<meta\b[^>]*\bname=["']apple-itunes-app["']/i;

export async function verifyWebDeploy({ baseURL, expectedSHA, deadlineMs = DEFAULT_DEADLINE_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, apiBaseURL = "https://api.chalkmeet.com", expectedEnvironment }) {
  const origin = normalizeBaseURL(baseURL);
  const apiOrigin = normalizeBaseURL(apiBaseURL);
  const normalizedSHA = normalizeSHA(expectedSHA);
  const deadline = Date.now() + deadlineMs;
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineMs));
  let attempt = 0;
  let lastError;

  while (Date.now() <= deadline) {
    attempt += 1;
    try {
      await verifyOnce(origin, apiOrigin, normalizedSHA, requestTimeoutMs, expectedEnvironment, deadlineSignal);
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
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    options: { production: { type: "boolean", default: false }, "api-base-url": { type: "string" }, environment: { type: "string" } },
  });
  if (positionals.length !== 2) throw new Error("Expected base URL and full commit SHA");
  if (values.environment && !["nightly", "production"].includes(values.environment)) throw new Error("Invalid target environment");
  return { baseURL: positionals[0], expectedSHA: normalizeSHA(positionals[1]), production: values.production, apiBaseURL: values["api-base-url"], expectedEnvironment: values.environment };
}

async function verifyOnce(baseURL, apiBaseURL, expectedSHA, requestTimeoutMs, expectedEnvironment, deadlineSignal) {
  await verifyServiceWorker(baseURL, expectedSHA, requestTimeoutMs, deadlineSignal);
  await verifyAPIHealth(apiBaseURL, requestTimeoutMs, deadlineSignal);
  if (expectedEnvironment) await verifyReleaseMarker(baseURL, expectedSHA, expectedEnvironment, requestTimeoutMs, deadlineSignal);
  await verifyAppLinks(baseURL, requestTimeoutMs, deadlineSignal);
  if (expectedEnvironment === "nightly") await verifyDashboard(baseURL, requestTimeoutMs, deadlineSignal);
}

async function verifyDashboard(baseURL, requestTimeoutMs, deadlineSignal) {
  const response = await request(endpointURL(baseURL, "/auth/session"), requestTimeoutMs, deadlineSignal);
  requireStatus(response, 401, "dashboard session");
  const session = await readJSON(response, "dashboard session");
  if (session?.error?.code !== "sign_in_required") throw new Error("dashboard did not report the signed-out state");
}

async function verifyReleaseMarker(baseURL, expectedSHA, expectedEnvironment, requestTimeoutMs, deadlineSignal) {
  const response = await request(endpointURL(baseURL, "/release.json"), requestTimeoutMs, deadlineSignal);
  requireStatus(response, 200, "release marker");
  const marker = await readJSON(response, "release marker");
  if (!marker || marker.environment !== expectedEnvironment || marker.commit !== expectedSHA) throw new Error("served web release mismatch");
}

async function verifyServiceWorker(baseURL, expectedSHA, requestTimeoutMs, deadlineSignal) {
  const serviceWorkerURL = endpointURL(baseURL, "/sw.js");
  serviceWorkerURL.searchParams.set("cb", expectedSHA);
  const serviceWorker = await request(serviceWorkerURL, requestTimeoutMs, deadlineSignal);
  requireStatus(serviceWorker, 200, "service worker");
  const serviceWorkerSource = await serviceWorker.text();
  const deployedSHA = serviceWorkerSource.match(/"commitHash"\s*:\s*"([0-9a-f]{40})"/i)?.[1]?.toLowerCase();
  if (deployedSHA !== expectedSHA) {
    throw new Error(`service worker has commit ${deployedSHA ?? "unknown"}, expected ${expectedSHA}`);
  }
}

// iOS and Android open call links in the app only after these files verify it.
async function verifyAppLinks(baseURL, requestTimeoutMs, deadlineSignal) {
  for (const pathname of APP_LINK_FILES) await verifyJSONFile(endpointURL(baseURL, pathname), requestTimeoutMs, deadlineSignal);
  const space = await request(endpointURL(baseURL, "/space/"), requestTimeoutMs, deadlineSignal);
  requireStatus(space, 200, "Space page");
  if (!SMART_APP_BANNER.test(await space.text())) throw new Error("Space page has no Smart App Banner tag");
}

async function verifyJSONFile(url, requestTimeoutMs, deadlineSignal) {
  const response = await request(url, requestTimeoutMs, deadlineSignal);
  requireStatus(response, 200, url.pathname);
  const contentType = response.headers.get("content-type") ?? "";
  if (response.redirected || !contentType.startsWith("application/json")) throw new Error(`${url.pathname} must be served as JSON without a redirect`);
  await readJSON(response, url.pathname);
}

async function verifyAPIHealth(baseURL, requestTimeoutMs, deadlineSignal) {
  const response = await request(endpointURL(baseURL, "/healthz"), requestTimeoutMs, deadlineSignal);
  requireStatus(response, 200, "API health");
  const health = await readJSON(response, "API health");
  if (health?.status !== "ok") throw new Error("API health did not report healthy status");
}

async function request(url, timeoutMs, deadlineSignal) {
  return fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([deadlineSignal, AbortSignal.timeout(timeoutMs)]),
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
