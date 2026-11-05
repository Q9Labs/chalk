import timers from "node:timers/promises";
import { check } from "./runtime.mjs";

const readBudgetMs = 90_000;

function isTransportFailure(error) {
  return (error instanceof TypeError && ["fetch failed", "terminated"].includes(error.message)) || error.name === "TimeoutError";
}

function retryDelay(header, attempt) {
  const backoff = Math.min(1000 * 2 ** attempt, 30_000);
  if (!header?.trim()) return backoff;
  const seconds = Number(header);
  const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(requested) ? Math.max(backoff, requested) : backoff;
}

export async function catcherRequest(base, path, method = "GET", body, signal, responseType = "json") {
  const deadline = Date.now() + readBudgetMs;
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  let transportFailures = 0;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    check(remainingMs > 0, `Webhook transport ${method} retry budget exhausted`);
    let waitMs;
    let failure;
    try {
      const response = await fetch(new URL(path, base), {
        ...options,
        signal: AbortSignal.any([AbortSignal.timeout(Math.min(15_000, remainingMs)), ...(signal ? [signal] : [])]),
      });
      if (response.ok) return await response[responseType]();
      failure = new Error(`Webhook transport ${method} failed: HTTP ${response.status}`);
      const retryable = method === "GET" && (response.status === 429 || response.status >= 500);
      await response.body?.cancel();
      if (!retryable) throw failure;
      waitMs = retryDelay(response.headers.get("Retry-After"), attempt);
    } catch (error) {
      signal?.throwIfAborted();
      if (method !== "GET" || !isTransportFailure(error) || ++transportFailures >= 3) throw error;
      failure = error;
      waitMs = retryDelay(undefined, attempt);
    }
    check(waitMs < deadline - Date.now(), `${failure.message}; retry budget exhausted`);
    await timers.setTimeout(waitMs, undefined, { signal });
  }
}
