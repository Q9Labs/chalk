import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_DEADLINE_MS = 300_000;
const DEFAULT_INITIAL_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const APP_LINK_FILES = ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"];
const SMART_APP_BANNER = /<meta\b[^>]*\bname=["']apple-itunes-app["']/i;

class CommitMismatchError extends Error {
  constructor(deployedSHA, expectedSHA) {
    super(`service worker has commit ${deployedSHA ?? "unknown"}, expected ${expectedSHA}`);
    this.deployedSHA = deployedSHA;
  }
}

export async function verifyWebDeploy({
  baseURL,
  expectedSHA,
  deadlineMs = DEFAULT_DEADLINE_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  apiBaseURL = "https://api.chalkmeet.com",
  expectedEnvironment,
  environment = process.env,
  now = Date.now,
  sleep = delay,
}) {
  const origin = normalizeBaseURL(baseURL);
  const apiOrigin = normalizeBaseURL(apiBaseURL);
  const normalizedSHA = normalizeSHA(expectedSHA);
  const startedAt = now();
  const deadline = startedAt + deadlineMs;
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineMs));
  let attempt = 0;
  let retryDelayMs = initialDelayMs;
  let lastError;
  let lastSeenSHA;
  let lastPagesNote = "";

  while (now() <= deadline) {
    attempt += 1;
    try {
      await verifyOnce(origin, apiOrigin, normalizedSHA, requestTimeoutMs, expectedEnvironment, deadlineSignal, `${attempt}-${now()}`);
      console.log(`Web deployment verified at ${origin.origin} on attempt ${attempt}.`);
      console.log(`web propagation: ${Math.round((now() - startedAt) / 1000)} s, attempts ${attempt}`);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof CommitMismatchError) {
        lastSeenSHA = error.deployedSHA;
        lastPagesNote = await describePagesDeployment(environment, normalizedSHA);
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      console.warn(`Verification attempt ${attempt} failed: ${errorMessage(error)}${lastPagesNote}. Retrying in ${Math.min(retryDelayMs, remainingMs) / 1000} s...`);
      await sleep(Math.min(retryDelayMs, remainingMs));
      retryDelayMs = Math.min(retryDelayMs * 2, maxDelayMs);
    }
  }

  const elapsedSeconds = Math.round((now() - startedAt) / 1000);
  throw new Error(`Web deployment verification failed at ${origin.origin} after ${attempt} attempts in ${elapsedSeconds} s: expected commit ${normalizedSHA}, last seen ${lastSeenSHA ?? "none"}: ${errorMessage(lastError)}${lastPagesNote}`);
}

// Tells "Pages has not promoted the deployment yet" from "Pages serves it but the alias still shows old content".
// Best effort: the verifier still works without Cloudflare credentials, such as in a local release.
async function describePagesDeployment(environment, expectedSHA) {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, PAGES_PROJECT: project } = environment;
  if (!account || !token || !project) return "";
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${encodeURIComponent(project)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return ` [Pages API returned ${response.status}]`;
    const deployment = (await response.json())?.result?.canonical_deployment;
    const commit = deployment?.deployment_trigger?.metadata?.commit_hash?.toLowerCase();
    const live = commit === expectedSHA;
    return ` [Pages production deployment ${deployment?.id ?? "unknown"} has commit ${commit ?? "unknown"}, ${live ? "so Pages has the new deployment live and the alias serves stale content" : "so the new deployment is not live at Pages yet"}]`;
  } catch (error) {
    return ` [Pages API lookup failed: ${errorMessage(error)}]`;
  }
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

async function verifyOnce(baseURL, apiBaseURL, expectedSHA, requestTimeoutMs, expectedEnvironment, deadlineSignal, cacheBuster) {
  await verifyServiceWorker(baseURL, expectedSHA, requestTimeoutMs, deadlineSignal, cacheBuster);
  await verifyAPIHealth(apiBaseURL, requestTimeoutMs, deadlineSignal);
  if (expectedEnvironment) await verifyReleaseMarker(baseURL, expectedSHA, expectedEnvironment, requestTimeoutMs, deadlineSignal, cacheBuster);
  await verifyAppLinks(baseURL, requestTimeoutMs, deadlineSignal);
  if (expectedEnvironment === "nightly") await verifyDashboard(baseURL, requestTimeoutMs, deadlineSignal);
}

async function verifyDashboard(baseURL, requestTimeoutMs, deadlineSignal) {
  const response = await request(endpointURL(baseURL, "/auth/session"), requestTimeoutMs, deadlineSignal);
  requireStatus(response, 401, "dashboard session");
  const session = await readJSON(response, "dashboard session");
  if (session?.error?.code !== "sign_in_required") throw new Error("dashboard did not report the signed-out state");
}

async function verifyReleaseMarker(baseURL, expectedSHA, expectedEnvironment, requestTimeoutMs, deadlineSignal, cacheBuster) {
  const response = await request(endpointURL(baseURL, "/release.json", cacheBuster), requestTimeoutMs, deadlineSignal);
  requireStatus(response, 200, "release marker");
  const marker = await readJSON(response, "release marker");
  if (!marker || marker.environment !== expectedEnvironment || marker.commit !== expectedSHA) throw new Error("served web release mismatch");
}

async function verifyServiceWorker(baseURL, expectedSHA, requestTimeoutMs, deadlineSignal, cacheBuster) {
  const serviceWorker = await request(endpointURL(baseURL, "/sw.js", cacheBuster), requestTimeoutMs, deadlineSignal);
  requireStatus(serviceWorker, 200, "service worker");
  const serviceWorkerSource = await serviceWorker.text();
  const deployedSHA = serviceWorkerSource.match(/"commitHash"\s*:\s*"([0-9a-f]{40})"/i)?.[1]?.toLowerCase();
  if (deployedSHA !== expectedSHA) throw new CommitMismatchError(deployedSHA, expectedSHA);
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
    headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
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

function endpointURL(baseURL, pathname, cacheBuster) {
  const url = new URL(pathname, baseURL);
  if (cacheBuster) url.searchParams.set("cb", cacheBuster);
  return url;
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
