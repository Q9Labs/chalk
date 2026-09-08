import { validateDiagnosticEventDraft, type DiagnosticEventDraft } from "@q9labsai/diagnostics-contracts";
import { parseTraceparent } from "../telemetry/trace";
import { safeSubject, type FeedbackContext } from "./context";
import {
  FEEDBACK_COOKIE_REGISTRY_VERSION,
  FEEDBACK_EVIDENCE_SCHEMA_VERSION,
  FEEDBACK_LOCAL_STATE_REGISTRY_VERSION,
  type FeedbackCookieInput,
  type FeedbackCookieEntryV1,
  type FeedbackDiagnosticsV1,
  type FeedbackEvidenceInput,
  type FeedbackEvidenceV1,
  type FeedbackLocalStateEntryV1,
  type FeedbackLocalStateInput,
  type FeedbackScreenshotCapture,
  type FeedbackScreenshotStateV1,
  type FeedbackScreenshotUnavailable,
  type FeedbackTelemetryStorageSummaryV1,
  type FeedbackTelemetrySnapshot,
} from "./types";
import { parseFeedbackEvidence } from "./validation";

export type FeedbackCollectionContext = Readonly<{
  readonly now?: () => number;
  readonly scope?: FeedbackEvidenceV1["scope"];
  readonly connection?: FeedbackEvidenceV1["connection"];
  readonly correlations?: FeedbackEvidenceV1["correlations"];
  readonly diagnostics?: FeedbackDiagnosticsV1;
}>;

export function collectFeedbackEvidence(input: FeedbackEvidenceInput, context: FeedbackCollectionContext = {}): FeedbackEvidenceV1 {
  const collectedAt = new Date((context.now ?? Date.now)()).toISOString();
  const evidence: FeedbackEvidenceV1 = {
    schema_version: FEEDBACK_EVIDENCE_SCHEMA_VERSION,
    collected_at: collectedAt,
    ...(input.app ? { app: input.app } : {}),
    sdk: input.sdk,
    platform: input.platform,
    ...(context.connection ? { connection: context.connection } : {}),
    ...(context.scope ? { scope: context.scope } : {}),
    correlations: context.correlations ?? {},
    diagnostics: context.diagnostics ?? unavailableDiagnostics(),
    local_state: { registry_version: FEEDBACK_LOCAL_STATE_REGISTRY_VERSION, entries: collectLocalState(input.local_state) },
    cookies: { registry_version: FEEDBACK_COOKIE_REGISTRY_VERSION, entries: collectCookies(input.cookies) },
    screenshot: screenshotState(input.screenshot),
  };
  return parseFeedbackEvidence(evidence);
}

export function collectFeedbackEvidenceFromContext(input: FeedbackEvidenceInput, context: FeedbackContext): FeedbackEvidenceV1 {
  const snapshot = context.connection();
  const subject = safeSubject(snapshot);
  const activeTelemetry = context.telemetry;
  const activeDiagnostics = context.diagnosticContext();
  const correlationContext = activeTelemetry ?? activeDiagnostics;
  const trace = parseTraceparent(correlationContext?.traceparent);
  const diagnostics = context.diagnosticSnapshot();
  const availability = context.diagnosticAvailability();
  return collectFeedbackEvidence(input, {
    now: context.now,
    connection: {
      state: snapshot.state,
      ...(snapshot.failure?.code ? { error_code: snapshot.failure.code } : {}),
    },
    ...(subject
      ? {
          scope: {
            space_id: subject.space_id,
            episode_id: subject.episode_id,
            participant_id: subject.participant_id,
          },
        }
      : {}),
    correlations: {
      ...(correlationContext ? { journey_id: correlationContext.journeyId } : {}),
      ...(activeTelemetry ? { root_journey_id: activeTelemetry.rootJourneyId } : {}),
      ...(trace ? { trace_id: trace.traceId, span_id: trace.spanId } : {}),
    },
    diagnostics: {
      availability,
      dropped_count: diagnostics.dropped,
      telemetry_events: input.local_state?.telemetry?.events ?? [],
      diagnostic_events: diagnostics.events.filter(isDiagnosticEvent),
    },
  });
}

export function collectLocalState(input: FeedbackLocalStateInput | undefined): readonly FeedbackLocalStateEntryV1[] {
  if (!input) return [];
  const entries: FeedbackLocalStateEntryV1[] = [];
  if (input.telemetry) {
    const summary = telemetrySummary(input.telemetry);
    if (summary) entries.push({ key: input.telemetry.storage_key ?? "chalk.web.telemetry.v1", value: summary });
  }
  if (input.tenant_hint && validUUID(input.tenant_hint)) entries.push({ key: "chalk.tenant-hint", value: input.tenant_hint });
  for (const request of input.dashboard_requests ?? []) {
    if (!request.pending || !/^[a-z][a-z0-9_-]{0,63}$/u.test(request.action)) continue;
    entries.push({ key: `chalk.dashboard-request.${request.action}`, value: true });
  }
  return entries.slice(0, 32);
}

export function collectCookies(input: FeedbackCookieInput | undefined): readonly FeedbackCookieEntryV1[] {
  if (!input) return [];
  const entries: FeedbackCookieEntryV1[] = [];
  if (input.theme !== undefined) entries.push({ name: "chalk_theme", present: true, value: input.theme });
  if (input.sidebar_state !== undefined) entries.push({ name: "chalk_sidebar_state", present: true, value: input.sidebar_state ? "true" : "false" });
  if (input.account_present !== undefined) entries.push({ name: "account", present: input.account_present });
  if (input.csrf_present !== undefined) entries.push({ name: "csrf", present: input.csrf_present });
  return entries;
}

function telemetrySummary(input: FeedbackTelemetrySnapshot): FeedbackTelemetryStorageSummaryV1 | undefined {
  const summary: FeedbackTelemetryStorageSummaryV1 = {
    ...(input.pending_count !== undefined && boundedCount(input.pending_count) ? { pending_count: input.pending_count } : {}),
    ...(input.timeline_count !== undefined && boundedCount(input.timeline_count) ? { timeline_count: input.timeline_count } : {}),
    ...(input.dropped_count !== undefined && boundedCount(input.dropped_count) ? { dropped_count: input.dropped_count } : {}),
  };
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function boundedCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 500;
}

function screenshotState(input: FeedbackScreenshotCapture | FeedbackScreenshotUnavailable | undefined): FeedbackScreenshotStateV1 {
  if (!input) return { state: "unavailable", failure_code: "unsupported" };
  if (input.state === "captured" || input.state === "partial") return { state: input.state, captured_at: input.captured_at };
  return "failure_code" in input && input.failure_code ? { state: input.state, failure_code: input.failure_code } : { state: input.state };
}

function unavailableDiagnostics(): FeedbackDiagnosticsV1 {
  return { availability: "unavailable", dropped_count: 0, telemetry_events: [], diagnostic_events: [] };
}

function isDiagnosticEvent(value: unknown): value is DiagnosticEventDraft {
  return validateDiagnosticEventDraft(value).ok;
}

function validUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) && value.replaceAll("0", "").replaceAll("-", "") !== "";
}
