// @ts-check

import { diagnosticCodeSchema, diagnosticEventSchema, diagnosticTraceBriefSchema, serverSpanSchema } from "@q9labsai/diagnostics";
import { asDiagnosticInspectError } from "./errors.mjs";

const MAX_EVENTS = 500;
const MAX_SPANS = 200;
const TRACE_FILTER_VERSION = "DiagnosticFilter/v1";

function emptyBrief(code, target, completeness) {
  return {
    version: 1,
    code,
    target,
    retrievedAt: new Date().toISOString(),
    completeness,
    summary: completeness === "expired" ? "Retained trace evidence expired" : "Trace evidence not found",
    events: [],
    serverSpans: [],
    errors: [],
    links: [],
    visibilityGaps: [],
    truncated: false,
  };
}

function statusFor(state) {
  if (["failed", "timed_out", "stalled"].includes(state)) return "error";
  return state === "succeeded" ? "ok" : "unset";
}

function safeName(value, fallback) {
  return typeof value === "string" && value.length <= 96 && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value) ? value : fallback;
}

function validTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

function mapEvent(raw, code) {
  const spanId = raw?.correlation?.spanId;
  const occurredAt = validTime(raw?.occurredAt);
  if (raw?.correlation?.traceId !== code || occurredAt === undefined) return undefined;
  const candidate = {
    version: 1,
    traceId: code,
    spanId,
    eventId: `event_${raw.cursor}`,
    occurredAt,
    source: ["ui", "sdk"].includes(raw.source) ? "browser" : "server",
    kind: statusFor(raw.state) === "error" ? "error" : "event",
    name: safeName(raw.name, "chalk.event"),
    status: statusFor(raw.state),
    level: statusFor(raw.state) === "error" ? "error" : "info",
  };
  const parsed = diagnosticEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function mapSpan(raw, code) {
  const occurredAt = validTime(raw?.startedAt);
  const traceId = typeof raw?.traceId === "string" ? raw.traceId : raw?.traceId?.idClass === "w3c.trace" && raw.traceId.copyable === true ? raw.traceId.value : undefined;
  const spanId = typeof raw?.spanId === "string" ? raw.spanId : raw?.spanId?.idClass === "w3c.span" && raw.spanId.copyable === true ? raw.spanId.value : undefined;
  if (traceId !== code || occurredAt === undefined || raw?.source === "ui" || raw?.source === "sdk") return undefined;
  const candidate = {
    traceId: code,
    spanId,
    name: safeName(raw.kind, "chalk.operation"),
    occurredAt,
    status: statusFor(raw.state),
    correlation: "unmatched",
    ...(Number.isFinite(raw.durationMilliseconds) && raw.durationMilliseconds >= 0 ? { durationMs: raw.durationMilliseconds } : {}),
  };
  const parsed = serverSpanSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function buildTraceBrief(code, target, eventPage, operationPage) {
  const sourceEvents = eventPage.events ?? [];
  const sourceOperations = operationPage.operations ?? [];
  const events = sourceEvents
    .map((event) => mapEvent(event, code))
    .filter(Boolean)
    .slice(0, MAX_EVENTS);
  const serverSpans = sourceOperations
    .map((operation) => mapSpan(operation, code))
    .filter(Boolean)
    .slice(0, MAX_SPANS);
  const eventErrors = events.filter((event) => event.kind === "error");
  const operationErrors = serverSpans
    .filter((span) => span.status === "error" && !eventErrors.some((event) => event.spanId === span.spanId))
    .map((span, index) =>
      diagnosticEventSchema.parse({
        version: 1,
        traceId: code,
        spanId: span.spanId,
        eventId: `operation_error_${index}`,
        occurredAt: span.occurredAt,
        source: "server",
        kind: "error",
        name: span.name,
        status: "error",
        level: "error",
      }),
    );
  const errors = [...eventErrors, ...operationErrors].slice(0, 100);
  const omitted = sourceEvents.length > events.length || sourceOperations.length > serverSpans.length;
  const visibilityGaps = [{ reason: "server_log_not_available", detail: "Server logs are outside retained Episode evidence" }];
  if (omitted) visibilityGaps.push({ reason: "not_observable", detail: "Some trace evidence lacks a complete span or safe timestamp" });
  return diagnosticTraceBriefSchema.parse({
    version: 1,
    code,
    target,
    retrievedAt: new Date().toISOString(),
    completeness: "partial",
    summary: "Retained Episode trace evidence",
    events,
    serverSpans,
    errors,
    links: [],
    visibilityGaps,
    truncated: Boolean(eventPage.hasMore || operationPage.hasMore || sourceEvents.length > MAX_EVENTS || sourceOperations.length > MAX_SPANS || eventErrors.length + operationErrors.length > 100),
  });
}

export async function lookupTraceBrief(code, target, client) {
  diagnosticCodeSchema.parse(code);
  const environment = client.config.environment;
  if ((target === "production" && environment !== "production") || (target === "development" && !["development", "localhost"].includes(environment)) || (target !== "development" && target !== "production" && target !== environment)) {
    throw new Error("Diagnostic target does not match the operator configuration");
  }
  let reference;
  try {
    const response = await client.resolveTrace(code);
    reference = response.body.reference;
  } catch (error) {
    const inspectError = asDiagnosticInspectError(error);
    if (inspectError.code === "not_found" || inspectError.code === "expired") {
      return diagnosticTraceBriefSchema.parse(emptyBrief(code, target, inspectError.code));
    }
    throw inspectError;
  }
  if (typeof reference !== "string") throw new Error("Diagnostic resolver returned no reference");
  const filters = JSON.stringify({ schemaVersion: TRACE_FILTER_VERSION, traceId: code });
  try {
    const [eventResponse, operationResponse] = await Promise.all([client.page(reference, "events", { filters, limit: MAX_EVENTS + 1 }), client.page(reference, "operations", { filters, limit: MAX_SPANS + 1 })]);
    return buildTraceBrief(code, target, eventResponse.body, operationResponse.body);
  } catch (error) {
    const inspectError = asDiagnosticInspectError(error);
    if (inspectError.code === "not_found" || inspectError.code === "expired") {
      return diagnosticTraceBriefSchema.parse(emptyBrief(code, target, inspectError.code));
    }
    throw inspectError;
  }
}

function targetFromArgs(args) {
  if (args.length === 0 || args[0] !== "trace") throw new Error("Expected trace <code>");
  const code = args[1];
  diagnosticCodeSchema.parse(code);
  if (args.length === 2) return { code, target: "development" };
  if (args.length === 3 && args[2] === "--prod") return { code, target: "production" };
  if (args.length === 4 && args[2] === "--deployment" && /^[a-zA-Z0-9_.:-]{1,96}$/.test(args[3])) return { code, target: args[3] };
  throw new Error("Invalid trace target");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const { code, target } = targetFromArgs(process.argv.slice(2));
    const { createDiagnosticClient } = await import("./client.mjs");
    const client = await createDiagnosticClient();
    process.stdout.write(`${JSON.stringify(await lookupTraceBrief(code, target, client))}\n`);
  } catch (error) {
    const inspectError = asDiagnosticInspectError(error);
    process.stderr.write(`diag ${inspectError.code}: ${inspectError.message}\n`);
    process.exitCode = inspectError.exitCode;
  }
}
