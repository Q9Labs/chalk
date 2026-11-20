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

/** The credential telemetry leaves under, as the outbox reads it at send time: the grant's telemetry credential, which outlives the call, and the media credential for a server that sends none. */
export function telemetryCredential(grant: ParsedAccessGrant | null): TelemetryCredential | null {
  if (!grant) return null;
  const { token, expiresAt } = grant.telemetry ?? grant.media;
  return { tenantId: grant.subject.tenantId, subject: `${grant.subject.tenantId}/${grant.subject.episodeId}/${grant.subject.participantId}`, token, expiresAt: Date.parse(expiresAt) };
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
