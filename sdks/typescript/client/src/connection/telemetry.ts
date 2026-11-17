import type { ParsedAccessGrant } from "../access/grant";
import type { TelemetryCredential, TelemetryEvent } from "../telemetry/types";
import type { ConnectionState } from "./types";

type EndReason = NonNullable<TelemetryEvent["end_reason"]>;

/** The facts the lifecycle holds about how a call ended. */
type EndFacts = { readonly removedByHost: boolean; readonly episodeEndConfirmed: boolean; readonly episodeEndReason: string | undefined; readonly timedOut: boolean };

/** Why a connection reached `left` or `failed`, from the state it left. Page closing is told by the platform, not here. */
export function callEndReason(from: ConnectionState, to: "left" | "failed", facts: EndFacts): EndReason {
  if (to === "failed") return from === "joining" ? "join_failed" : "connection_lost";
  if (facts.removedByHost) return "removed";
  if (facts.episodeEndConfirmed) return facts.episodeEndReason === "time_limit" ? "time_limit" : "episode_ended";
  return facts.timedOut ? "connection_lost" : "left";
}

/** The media credential of the grant, as the outbox reads it at send time. */
export function mediaCredential(grant: ParsedAccessGrant | null): TelemetryCredential | null {
  return grant ? { tenantId: grant.subject.tenantId, token: grant.media.token, expiresAt: Date.parse(grant.media.expiresAt) } : null;
}

/** Times one outage, from the first recovery request to the recovery that ends it. */
export function createOutageClock(now: () => number) {
  let startedAt: number | null = null;
  return {
    begin: () => {
      startedAt ??= now();
    },
    /** Milliseconds since `begin`, or undefined when no outage was open. */
    end: (): number | undefined => {
      const outage = startedAt === null ? undefined : now() - startedAt;
      startedAt = null;
      return outage;
    },
  };
}
