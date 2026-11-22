// fallow-ignore-file complexity -- every branch is a delivery step; the outbox delivery tests and the formal trace replay cover each one, which the CRAP estimate cannot see.
import { retryAfterMilliseconds } from "../connection/episode-status";
import type { SeqRange, TelemetrySend, TelemetrySendResult } from "./types";

/** The one POST both platforms make. Only a 2xx answer can settle seqs. */
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
    if (response.status === 400) {
      const body: unknown = await response.json().catch(() => null);
      if (body && typeof body === "object" && "error" in body) {
        const error = body.error;
        if (error && typeof error === "object" && "code" in error && error.code === "request.invalid") {
          return { status: 400, retryAfterMs, retryAfterUpgrade: true };
        }
      }
    } else {
      await response.body?.cancel();
    }
    return { status: response.status, retryAfterMs };
  }
  const answer = await readAnswer(response);
  return { status: response.status, retryAfterMs, ...answer };
}

type Answer = { readonly acks?: readonly SeqRange[]; readonly serverMs?: number };

/** Reads the seqs a 2xx answer settled and the server's clock when it answered. Either is left out when the body does not carry it in shape. */
async function readAnswer(response: Response): Promise<Answer> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {};
  }
  if (typeof body !== "object" || body === null) return {};
  const serverMs = "server_ms" in body && typeof body.server_ms === "number" && Number.isSafeInteger(body.server_ms) ? body.server_ms : undefined;
  const acks = "acks" in body ? readAcks(body.acks) : null;
  return { ...(acks ? { acks } : {}), ...(serverMs === undefined ? {} : { serverMs }) };
}

function readAcks(value: unknown): readonly SeqRange[] | null {
  if (!Array.isArray(value)) return null;
  const ranges: SeqRange[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || !("from" in entry) || !("to" in entry) || typeof entry.from !== "number" || typeof entry.to !== "number") return null;
    ranges.push({ from: entry.from, to: entry.to });
  }
  return ranges;
}
