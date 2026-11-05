import timers from "node:timers/promises";
import { check } from "./runtime.mjs";

const readBudgetMs = 90_000;

class CatcherHTTPError extends Error {
  constructor(response, method) {
    super(`Webhook transport ${method} failed: HTTP ${response.status}`);
    this.status = response.status;
    this.retryAfter = response.headers.get("Retry-After");
  }
}

function isTransportFailure(error) {
  return (error instanceof TypeError && ["fetch failed", "terminated"].includes(error.message)) || error.name === "TimeoutError";
}

function retryAfterMs(header) {
  if (!header?.trim()) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return Date.parse(header) - Date.now();
}

function retryDelay(header, attempt) {
  const backoff = Math.min(1000 * 2 ** attempt, 30_000);
  const requested = retryAfterMs(header);
  return Number.isFinite(requested) ? Math.max(backoff, requested) : backoff;
}

function canRetry(error, state) {
  if (error instanceof CatcherHTTPError) return error.status === 429 || error.status >= 500;
  state.transportFailures++;
  return isTransportFailure(error) && state.transportFailures < 3;
}

function requireRetry(error, method, state, signal) {
  signal?.throwIfAborted();
  if (method !== "GET" || !canRetry(error, state)) throw error;
}

async function readCatcher(url, options, deadline, signal, responseType) {
  const remainingMs = deadline - Date.now();
  check(remainingMs > 0, `Webhook transport ${options.method} retry budget exhausted`);
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.any([AbortSignal.timeout(Math.min(15_000, remainingMs)), ...(signal ? [signal] : [])]),
  });
  if (response.ok) return await response[responseType]();
  await response.body?.cancel();
  throw new CatcherHTTPError(response, options.method);
}

export async function catcherRequest(base, path, method = "GET", body, signal, responseType = "json") {
  const deadline = Date.now() + readBudgetMs;
  const url = new URL(path, base);
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const state = { transportFailures: 0 };
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await readCatcher(url, options, deadline, signal, responseType);
    } catch (error) {
      requireRetry(error, method, state, signal);
      const waitMs = retryDelay(error.retryAfter, attempt);
      check(waitMs < deadline - Date.now(), `${error.message}; retry budget exhausted`);
      await timers.setTimeout(waitMs, undefined, { signal });
    }
  }
}
