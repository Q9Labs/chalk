import type { EpisodeDiagnosticCredential } from "../access/episode-diagnostic-credential";
import type { ConnectionLifecycleSnapshot } from "../connection";
import type { JourneyTelemetryContext } from "../telemetry/types";
import type { FeedbackSource } from "./types";

export type FeedbackSafeSubject = Readonly<{
  tenant_id: string;
  space_id: string;
  episode_id: string;
  participant_id: string;
  participant_generation: number;
}>;

export type FeedbackDiagnosticContext = Readonly<{
  journeyId: string;
  traceparent: string;
  tracestate?: string;
}>;

/**
 * Private context owned by SpaceClientCore. The public controller only sees
 * safe evidence and receipts; the diagnostic credential stays in this closure.
 */
export type FeedbackContext = Readonly<{
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  createId: () => string;
  now: () => number;
  source: FeedbackSource;
  telemetry?: JourneyTelemetryContext;
  diagnosticContext: () => FeedbackDiagnosticContext | undefined;
  connection: () => ConnectionLifecycleSnapshot;
  diagnosticCredential: () => EpisodeDiagnosticCredential | null;
  diagnosticAvailability: () => "available" | "disabled" | "disposed" | "unavailable";
  diagnosticSnapshot: () => Readonly<{
    dropped: number;
    events: readonly unknown[];
  }>;
}>;

export function safeSubject(snapshot: ConnectionLifecycleSnapshot): FeedbackSafeSubject | undefined {
  const subject = snapshot.subject;
  if (!subject) return undefined;
  return {
    tenant_id: subject.tenantId,
    space_id: subject.spaceId,
    episode_id: subject.episodeId,
    participant_id: subject.participantId,
    participant_generation: subject.participantGeneration,
  };
}
