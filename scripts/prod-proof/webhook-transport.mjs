import { setTimeout as delay } from "node:timers/promises";
import { check } from "./runtime.mjs";

function isTransportFailure(error) {
  return (error instanceof TypeError && ["fetch failed", "terminated"].includes(error.message)) || error.name === "TimeoutError";
}

function requireRetry(error, attempts, signal) {
  signal?.throwIfAborted();
  if (attempts === 1 || !isTransportFailure(error)) throw error;
}

async function fetchCatcher(url, options, attempts, signal, responseType) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
    check(response.ok, `Webhook transport ${options.method} failed: HTTP ${response.status}`);
    return await response[responseType]();
  } catch (error) {
    requireRetry(error, attempts, signal);
    await delay(1000, undefined, { signal });
    return fetchCatcher(url, options, attempts - 1, signal, responseType);
  }
}

export async function catcherRequest(base, path, method = "GET", body, signal, responseType = "json") {
  return fetchCatcher(
    new URL(path, base),
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    method === "GET" ? 3 : 1,
    signal,
    responseType,
  );
}
