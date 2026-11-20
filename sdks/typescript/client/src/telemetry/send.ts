import { retryAfterMilliseconds } from "../connection/episode-status";
import type { SeqRange, TelemetrySend, TelemetrySendResult } from "./types";

/** The one POST both platforms make. Only a 2xx answer is read, for the seqs it settled: a status settles nothing. */
export async function postTelemetry(fetch: typeof globalThis.fetch, request: TelemetrySend): Promise<TelemetrySendResult> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${request.token}`, "Content-Type": "application/json", traceparent: request.traceparent },
    body: request.body,
    signal: request.signal,
    keepalive: request.keepalive,
    credentials: "omit",
  });
  const retryAfterMs = retryAfterMilliseconds(response.headers.get("Retry-After"), Date.now());
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, retryAfterMs };
  }
  const acks = await readAcks(response);
  return acks ? { status: response.status, retryAfterMs, acks } : { status: response.status, retryAfterMs };
}

async function readAcks(response: Response): Promise<readonly SeqRange[] | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || !("acks" in body) || !Array.isArray(body.acks)) return null;
  const ranges: SeqRange[] = [];
  for (const entry of body.acks) {
    if (typeof entry !== "object" || entry === null || !("from" in entry) || !("to" in entry) || typeof entry.from !== "number" || typeof entry.to !== "number") return null;
    ranges.push({ from: entry.from, to: entry.to });
  }
  return ranges;
}
