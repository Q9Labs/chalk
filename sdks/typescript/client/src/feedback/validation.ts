import { isDiagnosticReference, parseDiagnosticEventDraft, redactDiagnosticAttributes, type DiagnosticEventDraft } from "@q9labsai/diagnostics-contracts";
import { normalizeTelemetryAttributes } from "../telemetry/attributes";
import type { TelemetryEvent } from "../telemetry/types";
import {
  FEEDBACK_COOKIE_REGISTRY_VERSION,
  FEEDBACK_EVIDENCE_SCHEMA_VERSION,
  FEEDBACK_LOCAL_STATE_REGISTRY_VERSION,
  FEEDBACK_MAX_COOKIE_ENTRIES,
  FEEDBACK_MAX_DIAGNOSTIC_EVENTS,
  FEEDBACK_MAX_EVIDENCE_BYTES,
  FEEDBACK_MAX_LOCAL_STATE_ENTRIES,
  FEEDBACK_MAX_MESSAGE_BYTES,
  FEEDBACK_MAX_REQUEST_BYTES,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_MAX_SCREENSHOT_HEIGHT,
  FEEDBACK_MAX_SCREENSHOT_WIDTH,
  FEEDBACK_MAX_TELEMETRY_EVENTS,
  FEEDBACK_RECEIPT_SCHEMA_VERSION,
  FEEDBACK_REQUEST_SCHEMA_VERSION,
  FEEDBACK_SCREENSHOT_SCHEMA_VERSION,
  type FeedbackCategory,
  type FeedbackCookieEntryV1,
  type FeedbackCorrelationsV1,
  type FeedbackDiagnosticsV1,
  type FeedbackEvidenceV1,
  type FeedbackLocalStateEntryV1,
  type FeedbackLocalStateValue,
  type FeedbackPlatformKind,
  type FeedbackReportReceiptV1,
  type FeedbackReportRequestV1,
  type FeedbackScreenshotV1,
  type FeedbackScreenshotStateV1,
  type FeedbackSource,
} from "./types";

const encoder = new TextEncoder();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TRACE_ID_PATTERN = /^(?=.*[1-9a-f])[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^(?=.*[1-9a-f])[0-9a-f]{16}$/u;
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/iu;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{0,127}$/u;
const DASHBOARD_ACTION_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const UNSAFE_VALUE_PATTERN = /(?:https?:\/\/|wss?:\/\/|bearer\s+[a-z0-9._~+\/-]+|-----begin|candidate:|v=0\r?\n|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/iu;
const TELEMETRY_KEYS = ["version", "event_id", "journey_id", "sequence", "occurred_at", "name", "phase", "state", "origin_kind", "first_observed_layer", "upstream_visibility", "parent_event_id", "trace_id", "span_id", "traceparent", "tracestate", "attributes"] as const;
const TELEMETRY_NAMES = ["journey.started", "journey.phase", "journey.terminal", "journey.linked", "http.request", "sync.frame", "rtc.summary", "diagnostic.timeline"] as const;
const TELEMETRY_PHASES = ["root", "authentication", "signaling", "media", "recovery", "terminal"] as const;
const TELEMETRY_STATES = ["started", "in_progress", "succeeded", "failed", "cancelled", "observed"] as const;
const TELEMETRY_ORIGINS = ["client", "diagnostic", "http", "rtc", "sync"] as const;
const TELEMETRY_VISIBILITY = ["local", "propagated"] as const;

type TelemetryEventCandidate = Readonly<{
  version: 1;
  event_id: string;
  journey_id: string;
  sequence: number;
  occurred_at: string;
  name: TelemetryEvent["name"];
  phase: TelemetryEvent["phase"];
  state: TelemetryEvent["state"];
  origin_kind: TelemetryEvent["origin_kind"];
  first_observed_layer: TelemetryEvent["first_observed_layer"];
  upstream_visibility: TelemetryEvent["upstream_visibility"];
  parent_event_id?: string;
  trace_id?: string;
  span_id?: string;
  traceparent?: string;
  tracestate?: string;
  attributes?: TelemetryEvent["attributes"];
}>;

export type FeedbackValidationIssue = Readonly<{ path: string; message: string }>;
export type FeedbackValidationResult<T> = Readonly<{ ok: true; value: T } | { ok: false; issues: readonly FeedbackValidationIssue[] }>;

export class FeedbackValidationError extends Error {
  readonly issues: readonly FeedbackValidationIssue[];

  constructor(message: string, issues: readonly FeedbackValidationIssue[] = [{ path: "$", message }]) {
    super(message);
    this.name = "FeedbackValidationError";
    this.issues = issues;
  }
}

type FeedbackRequestFields = Readonly<{
  category: FeedbackCategory | undefined;
  source: FeedbackSource | undefined;
  message: string | undefined;
  evidence: FeedbackEvidenceV1 | undefined;
  screenshot: FeedbackScreenshotV1 | undefined;
  screenshot_valid: boolean;
}>;

export function validateFeedbackReportRequest(input: unknown): FeedbackValidationResult<FeedbackReportRequestV1> {
  const issues: FeedbackValidationIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return failure("$", "expected a feedback request object");
  checkKeys(input, ["schema_version", "category", "message", "source", "evidence", "screenshot"], issues, "$", false);
  if (property(input, "schema_version") !== FEEDBACK_REQUEST_SCHEMA_VERSION) issues.push({ path: "$.schema_version", message: "unsupported feedback request schema" });
  const fields = validateFeedbackRequestFields(input, issues);
  validateFeedbackScreenshotConsistency(fields, issues);
  if (!fields.category || !fields.source || !fields.message || !fields.evidence || !fields.screenshot_valid || issues.length > 0) return { ok: false, issues };
  const request: FeedbackReportRequestV1 = {
    schema_version: FEEDBACK_REQUEST_SCHEMA_VERSION,
    category: fields.category,
    message: fields.message,
    source: fields.source,
    evidence: fields.evidence,
    ...(fields.screenshot ? { screenshot: fields.screenshot } : {}),
  };
  return validateFeedbackRequestSize(request, issues);
}

function validateFeedbackRequestFields(input: object, issues: FeedbackValidationIssue[]): FeedbackRequestFields {
  const category = enumValue(property(input, "category"), ["bug", "feature_request", "other"] as const, "$.category", issues);
  const source = enumValue(property(input, "source"), ["embedded", "chalk_web", "chalk_mobile", "dashboard"] as const, "$.source", issues);
  const message = validateMessage(property(input, "message"), issues);
  const evidenceResult = validateFeedbackEvidence(property(input, "evidence"));
  appendIssues(issues, evidenceResult);
  const screenshotResult = validateRequestScreenshot(property(input, "screenshot"));
  appendIssues(issues, screenshotResult);
  return {
    category,
    source,
    message,
    evidence: evidenceResult.ok ? evidenceResult.value : undefined,
    screenshot: screenshotResult.ok ? screenshotResult.value : undefined,
    screenshot_valid: screenshotResult.ok,
  };
}

function validateRequestScreenshot(input: unknown): FeedbackValidationResult<FeedbackScreenshotV1 | undefined> {
  return input === undefined ? { ok: true, value: undefined } : validateFeedbackScreenshot(input);
}

function validateFeedbackScreenshotConsistency(fields: FeedbackRequestFields, issues: FeedbackValidationIssue[]): void {
  if (!fields.evidence) return;
  if (!fields.screenshot && requiresScreenshot(fields.evidence)) {
    issues.push({ path: "$.screenshot", message: "a captured screenshot payload is required" });
    return;
  }
  if (!fields.screenshot) return;
  if (!requiresScreenshot(fields.evidence)) issues.push({ path: "$.evidence.screenshot.state", message: "screenshot state must indicate a capture" });
  if (fields.evidence.screenshot.captured_at !== fields.screenshot.captured_at) issues.push({ path: "$.screenshot.captured_at", message: "screenshot timestamps must match" });
}

function requiresScreenshot(evidence: FeedbackEvidenceV1): boolean {
  return evidence.screenshot.state === "captured" || evidence.screenshot.state === "partial";
}

function validateFeedbackRequestSize(request: FeedbackReportRequestV1, issues: FeedbackValidationIssue[]): FeedbackValidationResult<FeedbackReportRequestV1> {
  if (encodedByteLength(request) > FEEDBACK_MAX_REQUEST_BYTES) issues.push({ path: "$", message: "feedback request exceeds 1 MiB" });
  return issues.length === 0 ? { ok: true, value: request } : { ok: false, issues };
}

function appendIssues<T>(issues: FeedbackValidationIssue[], result: FeedbackValidationResult<T>): void {
  if (!result.ok) issues.push(...result.issues);
}

export function parseFeedbackReportRequest(input: unknown): FeedbackReportRequestV1 {
  const result = validateFeedbackReportRequest(input);
  if (result.ok) return result.value;
  throw new FeedbackValidationError("Invalid feedback request", result.issues);
}

export function validateFeedbackEvidence(input: unknown): FeedbackValidationResult<FeedbackEvidenceV1> {
  const issues: FeedbackValidationIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return failure("$", "expected a feedback evidence object");
  checkKeys(input, ["schema_version", "collected_at", "app", "sdk", "platform", "connection", "scope", "correlations", "diagnostics", "local_state", "cookies", "screenshot"], issues, "$", false);
  if (property(input, "schema_version") !== FEEDBACK_EVIDENCE_SCHEMA_VERSION) issues.push({ path: "$.schema_version", message: "unsupported feedback evidence schema" });
  const app = validateApp(property(input, "app"), issues);
  const sdk = validateSDK(property(input, "sdk"), issues);
  const platform = validatePlatform(property(input, "platform"), issues);
  const connection = validateConnection(property(input, "connection"), issues);
  const scope = validateScope(property(input, "scope"), issues);
  const correlations = validateCorrelations(property(input, "correlations"), issues);
  const diagnostics = validateDiagnostics(property(input, "diagnostics"), issues);
  const localState = validateLocalState(property(input, "local_state"), issues);
  const cookies = validateCookies(property(input, "cookies"), issues);
  const screenshot = validateScreenshotState(property(input, "screenshot"), issues);
  if (!sdk || !platform || !correlations || !diagnostics || !localState || !cookies || !screenshot || issues.length > 0) return { ok: false, issues };
  const collectedAt = checkDateTimeValue(property(input, "collected_at"), "$.collected_at", issues);
  if (!collectedAt) return { ok: false, issues };
  const evidence: FeedbackEvidenceV1 = {
    schema_version: FEEDBACK_EVIDENCE_SCHEMA_VERSION,
    collected_at: collectedAt,
    ...(app ? { app } : {}),
    sdk,
    platform,
    ...(connection ? { connection } : {}),
    ...(scope ? { scope } : {}),
    correlations,
    diagnostics,
    local_state: localState,
    cookies,
    screenshot,
  };
  if (encodedByteLength(evidence) > FEEDBACK_MAX_EVIDENCE_BYTES) return failure("$", "feedback evidence exceeds 128 KiB");
  return { ok: true, value: evidence };
}

export function parseFeedbackEvidence(input: unknown): FeedbackEvidenceV1 {
  const result = validateFeedbackEvidence(input);
  if (result.ok) return result.value;
  throw new FeedbackValidationError("Invalid feedback evidence", result.issues);
}

export function validateFeedbackScreenshot(input: unknown): FeedbackValidationResult<FeedbackScreenshotV1> {
  const issues: FeedbackValidationIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return failure("$", "expected a screenshot object");
  checkKeys(input, ["schema_version", "mime_type", "width", "height", "captured_at", "data_base64"], issues, "$", false);
  if (property(input, "schema_version") !== FEEDBACK_SCREENSHOT_SCHEMA_VERSION) issues.push({ path: "$.schema_version", message: "unsupported screenshot schema" });
  const mimeType = enumValue(property(input, "mime_type"), ["image/jpeg", "image/png", "image/webp"] as const, "$.mime_type", issues);
  const width = boundedInteger(property(input, "width"), 1, FEEDBACK_MAX_SCREENSHOT_WIDTH, "$.width", issues);
  const height = boundedInteger(property(input, "height"), 1, FEEDBACK_MAX_SCREENSHOT_HEIGHT, "$.height", issues);
  const capturedAt = property(input, "captured_at");
  checkDateTime(capturedAt, "$.captured_at", issues);
  const dataInput = property(input, "data_base64");
  const data = typeof dataInput === "string" ? dataInput : undefined;
  if (!data || !validBase64(data)) issues.push({ path: "$.data_base64", message: "screenshot data must be base64" });
  else if (base64ByteLength(data) > FEEDBACK_MAX_SCREENSHOT_BYTES) issues.push({ path: "$.data_base64", message: "screenshot exceeds 450 KiB" });
  if (!mimeType || width === undefined || height === undefined || typeof capturedAt !== "string" || !data || issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { schema_version: FEEDBACK_SCREENSHOT_SCHEMA_VERSION, mime_type: mimeType, width, height, captured_at: capturedAt, data_base64: data } };
}

export function parseFeedbackScreenshot(input: unknown): FeedbackScreenshotV1 {
  const result = validateFeedbackScreenshot(input);
  if (result.ok) return result.value;
  throw new FeedbackValidationError("Invalid feedback screenshot", result.issues);
}

export function assertFeedbackReceipt(input: unknown): FeedbackReportReceiptV1 {
  const issues: FeedbackValidationIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new FeedbackValidationError("Invalid feedback receipt");
  checkKeys(input, ["schema_version", "id", "submitted_at"], issues, "$", false);
  const schemaVersion = property(input, "schema_version");
  const id = property(input, "id");
  const submittedAt = property(input, "submitted_at");
  if (schemaVersion !== FEEDBACK_RECEIPT_SCHEMA_VERSION) issues.push({ path: "$.schema_version", message: "unsupported receipt schema" });
  if (!isUUID(id)) issues.push({ path: "$.id", message: "receipt ID is not a valid ID" });
  checkDateTime(submittedAt, "$.submitted_at", issues);
  if (issues.length > 0 || typeof id !== "string" || typeof submittedAt !== "string") throw new FeedbackValidationError("Invalid feedback receipt", issues);
  return { schema_version: FEEDBACK_RECEIPT_SCHEMA_VERSION, id, submitted_at: submittedAt };
}

export function assertFeedbackMessage(message: string): string {
  const issues: FeedbackValidationIssue[] = [];
  const normalized = validateMessage(message, issues);
  if (!normalized) throw new FeedbackValidationError("Invalid feedback message", issues);
  return normalized;
}

function validateMessage(value: unknown, issues: FeedbackValidationIssue[]): string | undefined {
  if (typeof value !== "string") {
    issues.push({ path: "$.message", message: "message must be a string" });
    return undefined;
  }
  const message = value.trim();
  if (invalidMessageLength(message)) issues.push({ path: "$.message", message: "message must be between 1 and 8,000 UTF-8 bytes" });
  if (hasForbiddenMessageControl(message)) issues.push({ path: "$.message", message: "message contains a forbidden control character" });
  return hasMessageIssue(issues) ? undefined : message;
}

function invalidMessageLength(message: string): boolean {
  const bytes = encoder.encode(message).byteLength;
  return bytes < 1 || bytes > FEEDBACK_MAX_MESSAGE_BYTES;
}

function hasForbiddenMessageControl(message: string): boolean {
  for (const character of message) if (isForbiddenMessageControl(character)) return true;
  return false;
}

function isForbiddenMessageControl(character: string): boolean {
  return isControl(character) && character !== "\n" && character !== "\r" && character !== "\t";
}

function hasMessageIssue(issues: readonly FeedbackValidationIssue[]): boolean {
  return issues.some((issue) => issue.path === "$.message");
}

function validateApp(input: unknown, issues: FeedbackValidationIssue[]): FeedbackEvidenceV1["app"] {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.app", message: "app must be an object" });
    return undefined;
  }
  checkKeys(input, ["name", "version", "build"], issues, "$.app", false);
  const name = metadata(property(input, "name"), "$.app.name", issues, true);
  const version = metadata(property(input, "version"), "$.app.version", issues, false);
  const build = metadata(property(input, "build"), "$.app.build", issues, false);
  return name ? { name, ...(version ? { version } : {}), ...(build ? { build } : {}) } : undefined;
}

function validateSDK(input: unknown, issues: FeedbackValidationIssue[]): FeedbackEvidenceV1["sdk"] | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.sdk", message: "sdk must be an object" });
    return undefined;
  }
  checkKeys(input, ["client", "react", "react_native"], issues, "$.sdk", false);
  const client = metadata(property(input, "client"), "$.sdk.client", issues, true);
  const react = metadata(property(input, "react"), "$.sdk.react", issues, false);
  const reactNative = metadata(property(input, "react_native"), "$.sdk.react_native", issues, false);
  return client ? { client, ...(react ? { react } : {}), ...(reactNative ? { react_native: reactNative } : {}) } : undefined;
}

function validatePlatform(input: unknown, issues: FeedbackValidationIssue[]): FeedbackEvidenceV1["platform"] | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.platform", message: "platform must be an object" });
    return undefined;
  }
  checkKeys(input, ["kind", "os_name", "os_version", "browser_name", "browser_version", "device_class", "device_model"], issues, "$.platform", false);
  const kind = enumValue(property(input, "kind"), ["web", "ios", "android", "macos"] as const, "$.platform.kind", issues);
  const deviceClassInput = property(input, "device_class");
  const deviceClass = deviceClassInput === undefined ? undefined : enumValue(deviceClassInput, ["phone", "tablet", "desktop"] as const, "$.platform.device_class", issues);
  const values = {
    os_name: metadata(property(input, "os_name"), "$.platform.os_name", issues, false),
    os_version: metadata(property(input, "os_version"), "$.platform.os_version", issues, false),
    browser_name: metadata(property(input, "browser_name"), "$.platform.browser_name", issues, false),
    browser_version: metadata(property(input, "browser_version"), "$.platform.browser_version", issues, false),
    device_model: metadata(property(input, "device_model"), "$.platform.device_model", issues, false),
  };
  if (!kind) return undefined;
  return buildFeedbackPlatform(kind, values, deviceClass);
}

function buildFeedbackPlatform(
  kind: FeedbackEvidenceV1["platform"]["kind"],
  values: Readonly<{
    os_name: string | undefined;
    os_version: string | undefined;
    browser_name: string | undefined;
    browser_version: string | undefined;
    device_model: string | undefined;
  }>,
  deviceClass: FeedbackEvidenceV1["platform"]["device_class"] | undefined,
): FeedbackEvidenceV1["platform"] {
  return {
    kind,
    ...(values.os_name ? { os_name: values.os_name } : {}),
    ...(values.os_version ? { os_version: values.os_version } : {}),
    ...(values.browser_name ? { browser_name: values.browser_name } : {}),
    ...(values.browser_version ? { browser_version: values.browser_version } : {}),
    ...(deviceClass ? { device_class: deviceClass } : {}),
    ...(values.device_model ? { device_model: values.device_model } : {}),
  };
}

function validateConnection(input: unknown, issues: FeedbackValidationIssue[]): FeedbackEvidenceV1["connection"] {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.connection", message: "connection must be an object" });
    return undefined;
  }
  checkKeys(input, ["state", "error_code"], issues, "$.connection", false);
  const state = safeToken(property(input, "state"), "$.connection.state", issues, true);
  const errorCode = safeToken(property(input, "error_code"), "$.connection.error_code", issues, false);
  return state ? { state, ...(errorCode ? { error_code: errorCode } : {}) } : undefined;
}

function validateScope(input: unknown, issues: FeedbackValidationIssue[]): FeedbackEvidenceV1["scope"] {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.scope", message: "scope must be an object" });
    return undefined;
  }
  checkKeys(input, ["space_id", "episode_id", "participant_id"], issues, "$.scope", false);
  return buildFeedbackScope(optionalUUID(property(input, "space_id"), "$.scope.space_id", issues), optionalUUID(property(input, "episode_id"), "$.scope.episode_id", issues), optionalUUID(property(input, "participant_id"), "$.scope.participant_id", issues));
}

function buildFeedbackScope(space: string | undefined, episode: string | undefined, participant: string | undefined): FeedbackEvidenceV1["scope"] {
  if (!space && !episode && !participant) return {};
  return {
    ...(space ? { space_id: space } : {}),
    ...(episode ? { episode_id: episode } : {}),
    ...(participant ? { participant_id: participant } : {}),
  };
}

function validateCorrelations(input: unknown, issues: FeedbackValidationIssue[]): FeedbackCorrelationsV1 | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.correlations", message: "correlations must be an object" });
    return undefined;
  }
  checkKeys(input, ["journey_id", "root_journey_id", "trace_id", "span_id", "request_id", "command_id", "diagnostic_reference"], issues, "$.correlations", false);
  const journey = optionalUUID(property(input, "journey_id"), "$.correlations.journey_id", issues);
  const root = optionalUUID(property(input, "root_journey_id"), "$.correlations.root_journey_id", issues);
  const trace = optionalHex(property(input, "trace_id"), TRACE_ID_PATTERN, "$.correlations.trace_id", issues);
  const span = optionalHex(property(input, "span_id"), SPAN_ID_PATTERN, "$.correlations.span_id", issues);
  const request = optionalUUID(property(input, "request_id"), "$.correlations.request_id", issues);
  const command = optionalUUID(property(input, "command_id"), "$.correlations.command_id", issues);
  const diagnostic = validateDiagnosticReference(property(input, "diagnostic_reference"), issues);
  return buildFeedbackCorrelations(journey, root, trace, span, request, command, diagnostic);
}

function validateDiagnosticReference(input: unknown, issues: FeedbackValidationIssue[]): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !isDiagnosticReference(input)) {
    issues.push({ path: "$.correlations.diagnostic_reference", message: "diagnostic reference is malformed" });
    return undefined;
  }
  return input;
}

function buildFeedbackCorrelations(journey: string | undefined, root: string | undefined, trace: string | undefined, span: string | undefined, request: string | undefined, command: string | undefined, diagnostic: string | undefined): FeedbackCorrelationsV1 {
  return {
    ...(journey ? { journey_id: journey } : {}),
    ...(root ? { root_journey_id: root } : {}),
    ...(trace ? { trace_id: trace } : {}),
    ...(span ? { span_id: span } : {}),
    ...(request ? { request_id: request } : {}),
    ...(command ? { command_id: command } : {}),
    ...(diagnostic ? { diagnostic_reference: diagnostic } : {}),
  };
}

function validateDiagnostics(input: unknown, issues: FeedbackValidationIssue[]): FeedbackDiagnosticsV1 | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.diagnostics", message: "diagnostics must be an object" });
    return undefined;
  }
  checkKeys(input, ["availability", "dropped_count", "telemetry_events", "diagnostic_events"], issues, "$.diagnostics", false);
  const availability = enumValue(property(input, "availability"), ["available", "disabled", "disposed", "unavailable"] as const, "$.diagnostics.availability", issues);
  const dropped = boundedInteger(property(input, "dropped_count"), 0, Number.MAX_SAFE_INTEGER, "$.diagnostics.dropped_count", issues);
  const telemetry = validateTelemetryEvents(property(input, "telemetry_events"), issues);
  const diagnostic = validateDiagnosticEvents(property(input, "diagnostic_events"), issues);
  if (!availability || dropped === undefined || !telemetry || !diagnostic) return undefined;
  return { availability, dropped_count: dropped, telemetry_events: telemetry, diagnostic_events: diagnostic };
}

function validateTelemetryEvents(input: unknown, issues: FeedbackValidationIssue[]): readonly TelemetryEvent[] | undefined {
  if (!Array.isArray(input)) {
    issues.push({ path: "$.diagnostics.telemetry_events", message: "telemetry_events must be an array" });
    return undefined;
  }
  if (input.length > FEEDBACK_MAX_TELEMETRY_EVENTS) issues.push({ path: "$.diagnostics.telemetry_events", message: "too many telemetry events" });
  const events: TelemetryEvent[] = [];
  input.slice(0, FEEDBACK_MAX_TELEMETRY_EVENTS).forEach((event, index) => {
    const parsed = sanitizeTelemetryEvent(event, `$.diagnostics.telemetry_events[${index}]`, issues);
    if (parsed) events.push(parsed);
  });
  return events;
}

function validateDiagnosticEvents(input: unknown, issues: FeedbackValidationIssue[]): readonly DiagnosticEventDraft[] | undefined {
  if (!Array.isArray(input)) {
    issues.push({ path: "$.diagnostics.diagnostic_events", message: "diagnostic_events must be an array" });
    return undefined;
  }
  if (input.length > FEEDBACK_MAX_DIAGNOSTIC_EVENTS) issues.push({ path: "$.diagnostics.diagnostic_events", message: "too many diagnostic events" });
  const events: DiagnosticEventDraft[] = [];
  input.slice(0, FEEDBACK_MAX_DIAGNOSTIC_EVENTS).forEach((event, index) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      issues.push({ path: `$.diagnostics.diagnostic_events[${index}]`, message: "diagnostic event must be an object" });
      return;
    }
    const attributes = redactDiagnosticAttributes(property(event, "attributes")).attributes;
    const sanitized = { ...event, ...(Object.keys(attributes).length > 0 ? { attributes } : {}) };
    try {
      events.push(parseDiagnosticEventDraft(sanitized));
    } catch {
      issues.push({ path: `$.diagnostics.diagnostic_events[${index}]`, message: "diagnostic event failed the diagnostics contract" });
    }
  });
  return events;
}

function sanitizeTelemetryEvent(input: unknown, path: string, issues: FeedbackValidationIssue[]): TelemetryEvent | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path, message: "telemetry event must be an object" });
    return undefined;
  }
  checkKeys(input, TELEMETRY_KEYS, issues, path, false);
  const identity = validateTelemetryEventIdentity(input, path, issues);
  const shape = validateTelemetryEventShape(input, path, issues);
  if (!identity || !shape) return undefined;
  const optional = validateTelemetryEventOptionalFields(input, path, issues);
  return buildSanitizedTelemetryEvent(identity, shape, optional);
}

function buildSanitizedTelemetryEvent(identity: TelemetryEventIdentity, shape: TelemetryEventShape, optional: TelemetryEventOptionalFields): TelemetryEvent | undefined {
  const event = {
    version: 1,
    event_id: identity.eventId,
    journey_id: identity.journeyId,
    sequence: identity.sequence,
    occurred_at: identity.occurredAt,
    name: shape.name,
    phase: shape.phase,
    state: shape.state,
    origin_kind: shape.origin,
    first_observed_layer: shape.firstObserved,
    upstream_visibility: shape.visibility,
    ...(optional.parentEvent ? { parent_event_id: optional.parentEvent } : {}),
    ...(optional.traceId ? { trace_id: optional.traceId } : {}),
    ...(optional.spanId ? { span_id: optional.spanId } : {}),
    ...(optional.traceparent ? { traceparent: optional.traceparent } : {}),
    ...(optional.tracestate ? { tracestate: optional.tracestate } : {}),
    ...(optional.attributes ? { attributes: optional.attributes } : {}),
  } satisfies TelemetryEventCandidate;
  return isSanitizedTelemetryEvent(event) ? event : undefined;
}

type TelemetryEventIdentity = Readonly<{
  eventId: string;
  journeyId: string;
  sequence: number;
  occurredAt: string;
}>;

function validateTelemetryEventIdentity(input: object, path: string, issues: FeedbackValidationIssue[]): TelemetryEventIdentity | undefined {
  const version = property(input, "version") === 1;
  if (!version) issues.push({ path: `${path}.version`, message: "unsupported telemetry version" });
  const eventId = requiredUUID(property(input, "event_id"), `${path}.event_id`, issues);
  const journeyId = requiredUUID(property(input, "journey_id"), `${path}.journey_id`, issues);
  const sequence = boundedInteger(property(input, "sequence"), 0, Number.MAX_SAFE_INTEGER, `${path}.sequence`, issues);
  const occurredAt = checkDateTimeValue(property(input, "occurred_at"), `${path}.occurred_at`, issues);
  if (!version || !eventId || !journeyId || sequence === undefined || !occurredAt) return undefined;
  return { eventId, journeyId, sequence, occurredAt };
}

type TelemetryEventShape = Readonly<{
  name: TelemetryEventCandidate["name"];
  phase: TelemetryEventCandidate["phase"];
  state: TelemetryEventCandidate["state"];
  origin: TelemetryEventCandidate["origin_kind"];
  firstObserved: TelemetryEventCandidate["first_observed_layer"];
  visibility: TelemetryEventCandidate["upstream_visibility"];
}>;

function validateTelemetryEventShape(input: object, path: string, issues: FeedbackValidationIssue[]): TelemetryEventShape | undefined {
  const name = enumValue(property(input, "name"), TELEMETRY_NAMES, `${path}.name`, issues);
  const phase = enumValue(property(input, "phase"), TELEMETRY_PHASES, `${path}.phase`, issues);
  const state = enumValue(property(input, "state"), TELEMETRY_STATES, `${path}.state`, issues);
  const origin = enumValue(property(input, "origin_kind"), TELEMETRY_ORIGINS, `${path}.origin_kind`, issues);
  const firstObserved = enumValue(property(input, "first_observed_layer"), TELEMETRY_ORIGINS, `${path}.first_observed_layer`, issues);
  const visibility = enumValue(property(input, "upstream_visibility"), TELEMETRY_VISIBILITY, `${path}.upstream_visibility`, issues);
  if (!name || !phase || !state || !origin || !firstObserved || !visibility) return undefined;
  return { name, phase, state, origin, firstObserved, visibility };
}

type TelemetryEventOptionalFields = Readonly<{
  parentEvent: string | undefined;
  traceId: string | undefined;
  spanId: string | undefined;
  traceparent: string | undefined;
  tracestate: string | undefined;
  attributes: TelemetryEvent["attributes"];
}>;

function validateTelemetryEventOptionalFields(input: object, path: string, issues: FeedbackValidationIssue[]): TelemetryEventOptionalFields {
  return {
    parentEvent: optionalUUID(property(input, "parent_event_id"), `${path}.parent_event_id`, issues),
    traceId: optionalHex(property(input, "trace_id"), TRACE_ID_PATTERN, `${path}.trace_id`, issues),
    spanId: optionalHex(property(input, "span_id"), SPAN_ID_PATTERN, `${path}.span_id`, issues),
    traceparent: optionalTraceparent(property(input, "traceparent"), `${path}.traceparent`, issues),
    tracestate: optionalSafeText(property(input, "tracestate"), `${path}.tracestate`, 512, issues),
    attributes: sanitizeTelemetryAttributes(property(input, "attributes"), `${path}.attributes`, issues),
  };
}

function isSanitizedTelemetryEvent(value: TelemetryEventCandidate): value is TelemetryEvent {
  switch (value.name) {
    case "sync.frame":
      return value.origin_kind === "sync";
    case "http.request":
      return value.origin_kind === "http";
    case "rtc.summary":
      return value.origin_kind === "rtc";
    case "diagnostic.timeline":
      return value.origin_kind === "diagnostic";
    case "journey.started":
      return isJourneyStartedEvent(value);
    case "journey.phase":
      return isJourneyPhaseEvent(value);
    case "journey.terminal":
      return isJourneyTerminalEvent(value);
    case "journey.linked":
      return isJourneyLinkedEvent(value);
  }
}

function isJourneyStartedEvent(value: TelemetryEventCandidate): boolean {
  return value.origin_kind === "client" && value.phase === "root" && value.state === "started";
}

function isJourneyPhaseEvent(value: TelemetryEventCandidate): boolean {
  return value.origin_kind === "client" && value.phase !== "root" && value.phase !== "terminal" && (value.state === "in_progress" || value.state === "observed");
}

function isJourneyTerminalEvent(value: TelemetryEventCandidate): boolean {
  return value.origin_kind === "client" && value.phase === "terminal" && (value.state === "succeeded" || value.state === "failed" || value.state === "cancelled");
}

function isJourneyLinkedEvent(value: TelemetryEventCandidate): boolean {
  return value.origin_kind === "client" && value.phase === "root" && value.state === "observed" && typeof value.parent_event_id === "string";
}

function sanitizeTelemetryAttributes(input: unknown, path: string, issues: FeedbackValidationIssue[]): TelemetryEvent["attributes"] {
  if (input === undefined) return undefined;
  if (!isTelemetryAttributeObject(input)) {
    issues.push({ path, message: "telemetry attributes are not safe" });
    return undefined;
  }
  const redacted = redactDiagnosticAttributes(input).attributes;
  const normalized = normalizeTelemetryAttributes(redacted);
  if (!normalized) return undefined;
  for (const [key, value] of Object.entries(normalized)) if (typeof value === "string" && (value.length > 256 || isControlText(value) || UNSAFE_VALUE_PATTERN.test(value))) issues.push({ path: `${path}.${key}`, message: "telemetry attribute value is unsafe" });
  return normalized;
}

function isTelemetryAttributeObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => {
    const entry = property(value, key);
    return typeof entry === "boolean" || typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry));
  });
}

function validateLocalState(input: unknown, issues: FeedbackValidationIssue[]): FeedbackEvidenceV1["local_state"] | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.local_state", message: "local_state must be an object" });
    return undefined;
  }
  checkKeys(input, ["registry_version", "entries"], issues, "$.local_state", false);
  if (property(input, "registry_version") !== FEEDBACK_LOCAL_STATE_REGISTRY_VERSION) issues.push({ path: "$.local_state.registry_version", message: "unsupported local state registry" });
  const entriesInput = property(input, "entries");
  if (!Array.isArray(entriesInput)) {
    issues.push({ path: "$.local_state.entries", message: "local state entries must be an array" });
    return undefined;
  }
  if (entriesInput.length > FEEDBACK_MAX_LOCAL_STATE_ENTRIES) issues.push({ path: "$.local_state.entries", message: "too many local state entries" });
  const entries: FeedbackLocalStateEntryV1[] = [];
  const seen = new Set<string>();
  entriesInput.slice(0, FEEDBACK_MAX_LOCAL_STATE_ENTRIES).forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      issues.push({ path: `$.local_state.entries[${index}]`, message: "local state entry must be an object" });
      return;
    }
    checkKeys(entry, ["key", "value"], issues, `$.local_state.entries[${index}]`, false);
    const key = property(entry, "key");
    const entryValue = property(entry, "value");
    if (typeof key !== "string" || key.length === 0 || seen.has(key)) {
      issues.push({ path: `$.local_state.entries[${index}].key`, message: "local state key is invalid or duplicated" });
      return;
    }
    seen.add(key);
    if (!validLocalStateEntry(key, entryValue)) issues.push({ path: `$.local_state.entries[${index}]`, message: "local state entry is not allowlisted" });
    else if (isFeedbackLocalStateValue(entryValue)) entries.push({ key, value: entryValue });
  });
  return { registry_version: FEEDBACK_LOCAL_STATE_REGISTRY_VERSION, entries };
}

function validateCookies(input: unknown, issues: FeedbackValidationIssue[]): FeedbackEvidenceV1["cookies"] | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.cookies", message: "cookies must be an object" });
    return undefined;
  }
  checkKeys(input, ["registry_version", "entries"], issues, "$.cookies", false);
  if (property(input, "registry_version") !== FEEDBACK_COOKIE_REGISTRY_VERSION) issues.push({ path: "$.cookies.registry_version", message: "unsupported cookie registry" });
  const entriesInput = property(input, "entries");
  if (!Array.isArray(entriesInput)) {
    issues.push({ path: "$.cookies.entries", message: "cookie entries must be an array" });
    return undefined;
  }
  if (entriesInput.length > FEEDBACK_MAX_COOKIE_ENTRIES) issues.push({ path: "$.cookies.entries", message: "too many cookie entries" });
  const entries: FeedbackCookieEntryV1[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entriesInput.slice(0, FEEDBACK_MAX_COOKIE_ENTRIES).entries()) {
    const parsed = validateCookieEntry(entry, index, seen, issues);
    if (parsed) entries.push(parsed);
  }
  return { registry_version: FEEDBACK_COOKIE_REGISTRY_VERSION, entries };
}

function validateCookieEntry(input: unknown, index: number, seen: Set<string>, issues: FeedbackValidationIssue[]): FeedbackCookieEntryV1 | undefined {
  const path = `$.cookies.entries[${index}]`;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path, message: "cookie entry must be an object" });
    return undefined;
  }
  checkKeys(input, ["name", "present", "value"], issues, path, false);
  const name = enumValue(property(input, "name"), ["chalk_theme", "chalk_sidebar_state", "account", "csrf"] as const, `${path}.name`, issues);
  const present = property(input, "present");
  if (!name || typeof present !== "boolean" || seen.has(name)) {
    issues.push({ path, message: "cookie entry is invalid or duplicated" });
    return undefined;
  }
  seen.add(name);
  return buildCookieEntry(name, present, property(input, "value"), path, issues);
}

function buildCookieEntry(name: FeedbackCookieEntryV1["name"], present: boolean, input: unknown, path: string, issues: FeedbackValidationIssue[]): FeedbackCookieEntryV1 | undefined {
  const value = cookieValue(name, input, `${path}.value`, issues);
  if (!present && value !== undefined) issues.push({ path: `${path}.value`, message: "absent cookies cannot include values" });
  return { name, present, ...(value !== undefined ? { value } : {}) };
}

function cookieValue(name: FeedbackCookieEntryV1["name"], input: unknown, path: string, issues: FeedbackValidationIssue[]): FeedbackCookieEntryV1["value"] | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") {
    issues.push({ path, message: "cookie value is invalid" });
    return undefined;
  }
  if (name === "account" || name === "csrf") {
    issues.push({ path, message: "account and CSRF cookie values are never collected" });
    return undefined;
  }
  if (name === "chalk_theme") {
    const value = ["light", "dark", "system"] as const;
    const match = value.find((candidate) => candidate === input);
    if (match !== undefined) return match;
    issues.push({ path, message: "theme cookie value is invalid" });
    return undefined;
  }
  const value = ["true", "false"] as const;
  const match = value.find((candidate) => candidate === input);
  if (match !== undefined) return match;
  issues.push({ path, message: "sidebar cookie value is invalid" });
  return undefined;
}

function validateScreenshotState(input: unknown, issues: FeedbackValidationIssue[]): FeedbackScreenshotStateV1 | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path: "$.screenshot", message: "screenshot state must be an object" });
    return undefined;
  }
  checkKeys(input, ["state", "captured_at", "failure_code"], issues, "$.screenshot", false);
  const state = enumValue(property(input, "state"), ["captured", "partial", "removed", "unavailable"] as const, "$.screenshot.state", issues);
  const failureInput = property(input, "failure_code");
  const failure = failureInput === undefined ? undefined : enumValue(failureInput, ["capture_failed", "unsupported", "tainted", "secure_surface", "too_large"] as const, "$.screenshot.failure_code", issues);
  const capturedAtInput = property(input, "captured_at");
  const capturedAt = capturedAtInput === undefined ? undefined : checkDateTimeValue(capturedAtInput, "$.screenshot.captured_at", issues);
  validateScreenshotStateConsistency(state, capturedAt, failure, issues);
  if (!state) return undefined;
  return { state, ...(capturedAt ? { captured_at: capturedAt } : {}), ...(failure ? { failure_code: failure } : {}) };
}

function validateScreenshotStateConsistency(state: FeedbackScreenshotStateV1["state"] | undefined, capturedAt: string | undefined, failure: FeedbackScreenshotStateV1["failure_code"] | undefined, issues: FeedbackValidationIssue[]): void {
  const captured = state === "captured" || state === "partial";
  if (captured && !capturedAt) issues.push({ path: "$.screenshot.captured_at", message: "captured screenshots require a timestamp" });
  if (captured && failure) issues.push({ path: "$.screenshot.failure_code", message: "captured screenshots cannot have a failure code" });
}

function validLocalStateEntry(key: string, value: unknown): boolean {
  if (key === "chalk.tenant-hint") return isUUID(value);
  if (key === "chalk.web.telemetry.v1" || key === "chalk.mobile.telemetry.v1") return validTelemetrySummary(value);
  if (key.startsWith("chalk.dashboard-request.")) return DASHBOARD_ACTION_PATTERN.test(key.slice("chalk.dashboard-request.".length)) && value === true;
  return false;
}

function isFeedbackLocalStateValue(value: unknown): value is FeedbackLocalStateValue {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => {
      const entry = property(value, key);
      return typeof entry === "number" && Number.isFinite(entry);
    })
  );
}

function validTelemetrySummary(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = ["pending_count", "timeline_count", "dropped_count"] as const;
  if (!keys.some((key) => property(value, key) !== undefined)) return false;
  return keys.every((key) => {
    const entry = property(value, key);
    return entry === undefined || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 && entry <= 500);
  });
}

function metadata(value: unknown, path: string, issues: FeedbackValidationIssue[], required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !isSafeMetadata(value)) {
    issues.push({ path, message: required ? "metadata is required and unsafe" : "metadata is unsafe" });
    return undefined;
  }
  return value;
}

function isSafeMetadata(value: string): boolean {
  return value.length > 0 && value.length <= 128 && value.trim() === value && !isControlText(value) && !UNSAFE_VALUE_PATTERN.test(value);
}

function safeToken(value: unknown, path: string, issues: FeedbackValidationIssue[], required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !SAFE_TOKEN_PATTERN.test(value) || UNSAFE_VALUE_PATTERN.test(value)) {
    issues.push({ path, message: required ? "token is required and unsafe" : "token is unsafe" });
    return undefined;
  }
  return value;
}

function optionalUUID(value: unknown, path: string, issues: FeedbackValidationIssue[]): string | undefined {
  if (value === undefined) return undefined;
  return requiredUUID(value, path, issues);
}

function requiredUUID(value: unknown, path: string, issues: FeedbackValidationIssue[]): string | undefined {
  if (typeof value !== "string" || !isUUID(value)) {
    issues.push({ path, message: "expected a non-zero UUID" });
    return undefined;
  }
  return value;
}

function optionalHex(value: unknown, pattern: RegExp, path: string, issues: FeedbackValidationIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !pattern.test(value.toLowerCase()) || value !== value.toLowerCase()) {
    issues.push({ path, message: "expected a lower-case non-zero hexadecimal ID" });
    return undefined;
  }
  return value;
}

function optionalTraceparent(value: unknown, path: string, issues: FeedbackValidationIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TRACEPARENT_PATTERN.test(value)) {
    issues.push({ path, message: "traceparent is malformed" });
    return undefined;
  }
  return value;
}

function optionalSafeText(value: unknown, path: string, length: number, issues: FeedbackValidationIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > length || isControlText(value) || UNSAFE_VALUE_PATTERN.test(value)) {
    issues.push({ path, message: "text is unsafe" });
    return undefined;
  }
  return value;
}

function checkDateTime(value: unknown, path: string, issues: FeedbackValidationIssue[]): void {
  checkDateTimeValue(value, path, issues);
}

function checkDateTimeValue(value: unknown, path: string, issues: FeedbackValidationIssue[]): string | undefined {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    issues.push({ path, message: "expected an ISO date-time" });
    return undefined;
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, path: string, issues: FeedbackValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push({ path, message: "expected a bounded integer" });
    return undefined;
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string, issues: FeedbackValidationIssue[]): T | undefined {
  const match = values.find((candidate) => candidate === value);
  if (match !== undefined) return match;
  issues.push({ path, message: `expected one of: ${values.join(", ")}` });
  return undefined;
}

function checkKeys(value: object, allowed: readonly string[], issues: FeedbackValidationIssue[], path: string, allowNullable: boolean): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key) && !(allowNullable && key === "value")) issues.push({ path: `${path}.${key}`, message: "unknown property" });
}

function failure(path: string, message: string): FeedbackValidationResult<never> {
  return { ok: false, issues: [{ path, message }] };
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? Reflect.get(value, key) : undefined;
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value) && value.replaceAll("0", "").replaceAll("-", "") !== "";
}

function validBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function encodedByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function isControl(character: string): boolean {
  return /\p{Cc}/u.test(character);
}

function isControlText(value: string): boolean {
  for (const character of value) if (isControl(character)) return true;
  return false;
}

export function safePlatformKind(value: unknown): FeedbackPlatformKind | undefined {
  const candidates = ["web", "ios", "android", "macos"] as const;
  return candidates.find((candidate) => candidate === value);
}

export function safeSource(value: unknown): FeedbackSource | undefined {
  const candidates = ["embedded", "chalk_web", "chalk_mobile", "dashboard"] as const;
  return candidates.find((candidate) => candidate === value);
}

export function safeCategory(value: unknown): FeedbackCategory | undefined {
  const candidates = ["bug", "feature_request", "other"] as const;
  return candidates.find((candidate) => candidate === value);
}

export type SanitizedDiagnosticEvent = DiagnosticEventDraft;
