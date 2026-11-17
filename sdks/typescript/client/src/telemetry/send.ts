import { retryAfterMilliseconds } from "../connection/episode-status";
import type { TelemetrySend, TelemetrySendResult } from "./types";

/** The one POST both platforms make. The body of the answer never matters, so it is not read. */
export async function postTelemetry(fetch: typeof globalThis.fetch, request: TelemetrySend): Promise<TelemetrySendResult> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${request.token}`, "Content-Type": "application/json", traceparent: request.traceparent },
    body: request.body,
    signal: request.signal,
    keepalive: request.keepalive,
    credentials: "omit",
  });
  await response.body?.cancel();
  return { status: response.status, retryAfterMs: retryAfterMilliseconds(response.headers.get("Retry-After"), Date.now()) };
}
