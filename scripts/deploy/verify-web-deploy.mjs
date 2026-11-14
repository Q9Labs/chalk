import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { errorMessage } from "../lib/errors.mjs";

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

const DEFAULT_SETTINGS = {
  deadlineMs: DEFAULT_DEADLINE_MS,
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  apiBaseURL: "https://api.chalkmeet.com",
  environment: process.env,
  now: Date.now,
  sleep: delay,
};

export async function verifyWebDeploy(options) {
  const settings = { ...DEFAULT_SETTINGS, ...options };
  const target = {
    origin: normalizeBaseURL(settings.baseURL),
    apiOrigin: normalizeBaseURL(settings.apiBaseURL),
    expectedSHA: normalizeSHA(settings.expectedSHA),
    expectedEnvironment: settings.expectedEnvironment,
    requestTimeoutMs: settings.requestTimeoutMs,
    deadlineSignal: AbortSignal.timeout(Math.max(1, settings.deadlineMs)),
  };
  const startedAt = settings.now();
  const deadline = startedAt + settings.deadlineMs;
  const progress = { attempt: 0, lastError: undefined, lastSeenSHA: undefined, pagesNote: "" };
  let retryDelayMs = settings.initialDelayMs;

  while (settings.now() <= deadline) {
    if (await attemptOnce(target, settings, progress)) {
      console.log(`Web deployment verified at ${target.origin.origin} on attempt ${progress.attempt}.`);
      console.log(`web propagation: ${elapsedSeconds(settings, startedAt)} s, attempts ${progress.attempt}`);
      return;
    }
    const remainingMs = deadline - settings.now();
    if (remainingMs <= 0) break;
    const waitMs = Math.min(retryDelayMs, remainingMs);
    console.warn(`Verification attempt ${progress.attempt} failed: ${errorMessage(progress.lastError)}${progress.pagesNote}. Retrying in ${waitMs / 1000} s...`);
    await settings.sleep(waitMs);
    retryDelayMs = Math.min(retryDelayMs * 2, settings.maxDelayMs);
  }

  throw new Error(failureMessage(target, progress, elapsedSeconds(settings, startedAt)));
}

async function attemptOnce(target, settings, progress) {
  progress.attempt += 1;
  try {
    await verifyOnce(target.origin, target.apiOrigin, target.expectedSHA, target.requestTimeoutMs, target.expectedEnvironment, target.deadlineSignal, `${progress.attempt}-${settings.now()}`);
    return true;
  } catch (error) {
    progress.lastError = error;
    if (error instanceof CommitMismatchError) {
      progress.lastSeenSHA = error.deployedSHA;
      progress.pagesNote = await describePagesDeployment(settings.environment, target.expectedSHA);
    }
    return false;
  }
}

function elapsedSeconds(settings, startedAt) {
  return Math.round((settings.now() - startedAt) / 1000);
}

function failureMessage(target, progress, seconds) {
  const seen = progress.lastSeenSHA ?? "none";
  return `Web deployment verification failed at ${target.origin.origin} after ${progress.attempt} attempts in ${seconds} s: expected commit ${target.expectedSHA}, last seen ${seen}: ${errorMessage(progress.lastError)}${progress.pagesNote}`;
}

// Tells "Pages has not promoted the deployment yet" from "Pages serves it but the alias still shows old content".
// Best effort: the verifier still works without Cloudflare credentials, such as in a local release.
async function describePagesDeployment(environment, expectedSHA) {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, PAGES_PROJECT: project } = environment;
  if (![account, token, project].every(Boolean)) return "";
  try {
    return pagesNote(await fetchPagesProject(account, token, project), expectedSHA);
  } catch (error) {
    return ` [Pages API lookup failed: ${errorMessage(error)}]`;
  }
}

async function fetchPagesProject(account, token, project) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${encodeURIComponent(project)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Pages API returned ${response.status}`);
  return response.json();
}

function pagesNote(project, expectedSHA) {
  const commit = String(valueAt(project, "result", "canonical_deployment", "deployment_trigger", "metadata", "commit_hash") ?? "unknown").toLowerCase();
  const verdict = commit === expectedSHA ? "so Pages has the new deployment live and the alias serves stale content" : "so the new deployment is not live at Pages yet";
  return ` [Pages production deployment has commit ${commit}, ${verdict}]`;
}

function valueAt(value, ...keys) {
  return keys.reduce((current, key) => current?.[key], value);
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

if (import.meta.main) {
  verifyWebDeploy(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
