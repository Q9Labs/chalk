import { legacyOf } from "./queue";
import type { PlatformState, TelemetrySendResult, WireEvent } from "./types";

// When the outbox sends a record, and what the server's answer to a batch means.

/** Events that say a bad thing may be starting go out at once, because the client may not live to send them later. */
const STARTED_PLATFORM_STATES: ReadonlySet<PlatformState | undefined> = new Set(["offline", "hidden", "background"]);
const ROUTINE_DELAY_MS = 1500;
const STATS_DELAY_MS = 30_000;

type Verdict = "accepted" | "refresh" | "retry" | "lost";

/** Only the current grant can be refreshed, and only once until a request succeeds, so a rejected credential of an earlier call is gone for good. A status settles nothing: only a 2xx answer that names its acks does. */
export function judge(result: TelemetrySendResult | null, canRefresh: boolean, current: boolean): Verdict {
  if (result === null) return "retry";
  if (result.status >= 200 && result.status < 300) return result.acks ? "accepted" : "retry";
  if (result.status === 401) return !current ? "lost" : canRefresh ? "refresh" : "retry";
  return result.status === 429 || result.status >= 500 ? "retry" : "lost";
}

/** How long the drain waits before it sends a new record. */
export function delayFor(wire: WireEvent): number {
  const event = legacyOf(wire);
  if (!event) return ROUTINE_DELAY_MS;
  if (event.type === "call_stats") return STATS_DELAY_MS;
  if (event.type === "platform_changed" && STARTED_PLATFORM_STATES.has(event.platform_state)) return 0;
  if (event.type === "space_join_span" && event.outcome === "started") return 0;
  return ROUTINE_DELAY_MS;
}
