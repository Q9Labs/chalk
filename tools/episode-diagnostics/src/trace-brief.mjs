// @ts-check

import { diagnosticCodeSchema, diagnosticEventSchema, diagnosticTraceBriefSchema, serverSpanSchema } from "@q9labsai/diagnostics";
import { asDiagnosticInspectError } from "./errors.mjs";

const MAX_EVENTS = 500;
const MAX_SPANS = 200;
const TRACE_FILTER_VERSION = "DiagnosticFilter/v1";
const FLOW = "recording.provider.callback";
const FLOW_STEPS = new Set(["authorized_branch", "attempt", "provider_result", "artifact_state"]);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;

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

function mapEvent(raw, code, flowRun, includeRun = false) {
  const spanId = raw?.correlation?.spanId;
  const occurredAt = validTime(raw?.occurredAt);
  if (raw?.correlation?.traceId !== code || occurredAt === undefined) return undefined;
  const checkpoint = raw.name === FLOW && !(raw.phase === "intent" && raw.state === "started") ? (raw.expectation?.checkpoint ?? raw.attributes?.checkpoint) : undefined;
  const run = includeRun ? flowRun : (raw.diagnosticId ?? flowRun ?? raw.producerOperationRef);
  const attributes = FLOW_STEPS.has(checkpoint) && typeof run === "string" && RUN_ID.test(run) ? { flow: FLOW, flow_run: run, flow_step: checkpoint, outcome: raw.state } : includeRun ? { flow_run: flowRun } : undefined;
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
    ...(attributes ? { attributes } : {}),
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

export function buildTraceBrief(code, target, eventPage, operationPage, flowRun) {
  const sourceEvents = eventPage.events ?? [];
  const sourceOperations = operationPage.operations ?? [];
  const events = sourceEvents
    .map((event) => mapEvent(event, code, flowRun))
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
  const errorsOmitted = eventErrors.length + operationErrors.length > errors.length;
  const incomplete = omitted || errorsOmitted || Boolean(eventPage.hasMore || operationPage.hasMore);
  const visibilityGaps = incomplete ? [{ reason: "not_observable", detail: "Some retained Episode evidence is unavailable on this page" }] : [];
  return diagnosticTraceBriefSchema.parse({
    version: 1,
    code,
    target,
    retrievedAt: new Date().toISOString(),
    completeness: incomplete ? "partial" : "complete",
    summary: "Retained Episode trace evidence",
    events,
    serverSpans,
    errors,
    links: [],
    visibilityGaps,
    truncated: Boolean(eventPage.hasMore || operationPage.hasMore || sourceEvents.length > MAX_EVENTS || sourceOperations.length > MAX_SPANS || errorsOmitted),
  });
}

export async function lookupTraceBrief(code, target, client) {
  diagnosticCodeSchema.parse(code);
  assertTarget(target, client.config.environment);
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
    const flowRun = /^chalkdiag:v1:[a-z]+:([A-Za-z0-9][A-Za-z0-9_-]{0,127})/.exec(reference)?.[1];
    return buildTraceBrief(code, target, eventResponse.body, operationResponse.body, flowRun);
  } catch (error) {
    const inspectError = asDiagnosticInspectError(error);
    if (inspectError.code === "not_found" || inspectError.code === "expired") {
      return diagnosticTraceBriefSchema.parse(emptyBrief(code, target, inspectError.code));
    }
    throw inspectError;
  }
}

function targetFromArgs(args) {
  if (!["trace", "run"].includes(args[0])) throw new Error("Expected trace <code> or run <flowRun>");
  const [kind, value, ...flags] = args;
  if (kind === "trace") diagnosticCodeSchema.parse(value);
  else if (typeof value !== "string" || !RUN_ID.test(value)) throw new Error("Invalid flow run");
  let target = "development";
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === "--prod") target = "production";
    else if (flags[index] === "--deployment" && /^[a-zA-Z0-9_.:-]{1,96}$/.test(flags[index + 1] ?? "")) target = flags[++index];
    else if (kind === "trace" && flags[index] === "--limit" && /^(?:[1-9][0-9]{0,2}|1000)$/.test(flags[index + 1] ?? "")) index++;
    else if (kind === "trace" && flags[index] === "--after" && typeof flags[index + 1] === "string") index++;
    else throw new Error("Invalid diagnostic target or paging option");
  }
  return { kind, value, target };
}

function assertTarget(target, environment) {
  if ((target === "production" && environment !== "production") || (target === "development" && !["development", "localhost"].includes(environment)) || (target !== "development" && target !== "production" && target !== environment)) {
    throw new Error("Diagnostic target does not match the operator configuration");
  }
}

export async function lookupFlowRun(flowRun, target, client) {
  if (!RUN_ID.test(flowRun)) throw new Error("Invalid flow run");
  assertTarget(target, client.config.environment);
  const reference = `chalkdiag:v1:${client.config.environment}:${flowRun}`;
  const events = [];
  let afterCursor;
  do {
    const response = await client.page(reference, "events", { limit: 1000, ...(afterCursor === undefined ? {} : { afterCursor }) });
    const page = response.body;
    for (const event of page.events ?? []) {
      const code = event?.correlation?.traceId;
      if (typeof code === "string" && diagnosticCodeSchema.safeParse(code).success) {
        const mapped = mapEvent(event, code, flowRun, true);
        if (mapped) events.push(mapped);
      }
    }
    if (!page.hasMore) break;
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= (afterCursor ?? -1)) throw new Error("Diagnostic run paging did not advance");
    afterCursor = page.nextCursor;
  } while (true);
  return { events };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const { kind, value, target } = targetFromArgs(process.argv.slice(2));
    const { createDiagnosticClient } = await import("./client.mjs");
    const client = await createDiagnosticClient();
    const result = kind === "run" ? await lookupFlowRun(value, target, client) : await lookupTraceBrief(value, target, client);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const inspectError = asDiagnosticInspectError(error);
    process.stderr.write(`diag ${inspectError.code}: ${inspectError.message}\n`);
    process.exitCode = inspectError.exitCode;
  }
}
