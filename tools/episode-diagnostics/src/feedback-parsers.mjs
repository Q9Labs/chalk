// @ts-check

import { TextDecoder } from "node:util";
import { DiagnosticInspectError } from "./errors.mjs";
import { parseReference } from "./reference.mjs";

/** @typedef {null | boolean | number | string | JsonArray | JsonObject} JsonValue */
/** @typedef {JsonValue[]} JsonArray */
/** @typedef {{ [key: string]: JsonValue }} JsonObject */
/** @typedef {"bug" | "feature_request" | "other"} FeedbackCategory */
/** @typedef {"embedded" | "chalk_web" | "chalk_mobile" | "dashboard"} FeedbackSource */
/** @typedef {"account" | "participant"} FeedbackSubmitterKind */
/** @typedef {"web" | "ios" | "android" | "macos"} FeedbackPlatformKind */
/** @typedef {"phone" | "tablet" | "desktop"} FeedbackDeviceClass */
/** @typedef {"available" | "disabled" | "disposed" | "unavailable"} FeedbackDiagnosticsAvailability */
/** @typedef {"captured" | "partial" | "removed" | "unavailable"} FeedbackScreenshotState */
/** @typedef {"capture_failed" | "unsupported" | "tainted" | "secure_surface" | "too_large"} FeedbackScreenshotFailure */

/**
 * @typedef {{ journey_id?: string; root_journey_id?: string; trace_id?: string; span_id?: string; request_id?: string; command_id?: string; diagnostic_reference?: string }} FeedbackCorrelations
 */
/** @typedef {{ size: number; sha256: string; screenshot: boolean; failure_code?: string }} FeedbackEvidenceState */
/** @typedef {{ schema_version: "FeedbackReport/v1"; id: string; tenant_id: string; category: FeedbackCategory; source: FeedbackSource; message: string; submitter_kind: FeedbackSubmitterKind; correlations: FeedbackCorrelations; evidence: FeedbackEvidenceState; created_at: string; submitted_at: string; environment?: string; audience?: string; space_id?: string; episode_id?: string; participant_id?: string; diagnostic_reference?: string }} FeedbackReport */
/** @typedef {{ reports: FeedbackReport[]; has_more: boolean; next_cursor?: string }} FeedbackListResponse */
/** @typedef {{ client: string; react?: string; react_native?: string }} FeedbackSDK */
/** @typedef {{ kind: FeedbackPlatformKind; os_name?: string; os_version?: string; browser_name?: string; browser_version?: string; device_class?: FeedbackDeviceClass; device_model?: string }} FeedbackPlatform */
/** @typedef {{ name: string; version?: string; build?: string }} FeedbackApp */
/** @typedef {{ state: string; error_code?: string }} FeedbackConnection */
/** @typedef {{ space_id?: string; episode_id?: string; participant_id?: string }} FeedbackScope */
/** @typedef {{ availability: FeedbackDiagnosticsAvailability; dropped_count: number; telemetry_events: JsonValue[]; diagnostic_events: JsonValue[] }} FeedbackDiagnostics */
/** @typedef {{ key: string; value: JsonValue }} FeedbackStateEntry */
/** @typedef {{ registry_version: "FeedbackLocalState/v1"; entries: FeedbackStateEntry[] }} FeedbackLocalState */
/** @typedef {{ name: string; present: boolean; value?: string }} FeedbackCookie */
/** @typedef {{ registry_version: "FeedbackCookies/v1"; entries: FeedbackCookie[] }} FeedbackCookies */
/** @typedef {{ state: FeedbackScreenshotState; captured_at?: string; failure_code?: FeedbackScreenshotFailure }} FeedbackScreenshot */
/** @typedef {{ schema_version: "FeedbackEvidence/v1"; collected_at: string; sdk: FeedbackSDK; platform: FeedbackPlatform; correlations: FeedbackCorrelations; diagnostics: FeedbackDiagnostics; local_state: FeedbackLocalState; cookies: FeedbackCookies; screenshot: FeedbackScreenshot; app?: FeedbackApp; connection?: FeedbackConnection; scope?: FeedbackScope }} FeedbackEvidence */
/** @typedef {{ value: FeedbackEvidence; bytes: Uint8Array }} FeedbackEvidenceBytes */

export const FEEDBACK_REPORT_SCHEMA = "FeedbackReport/v1";
export const FEEDBACK_EVIDENCE_SCHEMA = "FeedbackEvidence/v1";
const MAX_FEEDBACK_REPORTS = 100;
const MAX_FEEDBACK_MESSAGE_BYTES = 8_000;
export const MAX_FEEDBACK_EVIDENCE_BYTES = 128 * 1024;

const FEEDBACK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX_PATTERN = /^[0-9a-f]+$/u;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const FORBIDDEN_KEY_PATTERN = /(?:authorization|cookie|credential|password|secret|token|private[_-]?key|data[_-]?base64)/iu;

const REPORT_REQUIRED_KEYS = ["schema_version", "id", "tenant_id", "category", "source", "message", "submitter_kind", "correlations", "evidence", "created_at", "submitted_at"];
const REPORT_OPTIONAL_KEYS = ["environment", "audience", "space_id", "episode_id", "participant_id", "diagnostic_reference"];
const CORRELATION_KEYS = ["journey_id", "root_journey_id", "trace_id", "span_id", "request_id", "command_id", "diagnostic_reference"];
const EVIDENCE_REQUIRED_KEYS = ["schema_version", "collected_at", "sdk", "platform", "correlations", "diagnostics", "local_state", "cookies", "screenshot"];
const EVIDENCE_OPTIONAL_KEYS = ["app", "connection", "scope"];

/**
 * @param {unknown} value
 * @returns {string}
 */
export function parseFeedbackId(value) {
  if (typeof value !== "string" || !FEEDBACK_ID_PATTERN.test(value)) throw contractError("Feedback report id is invalid");
  return value.toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {FeedbackListResponse}
 */
export function parseFeedbackListResponse(value) {
  const body = record(value, "Feedback list response");
  keys(body, ["reports", "has_more"], ["next_cursor"], "Feedback list response");
  validateListReports(body.reports);
  const pagination = parseListPagination(body);
  return { reports: body.reports.map(parseFeedbackReport), ...pagination };
}

/** @param {unknown} reports */
function validateListReports(reports) {
  if (!Array.isArray(reports) || reports.length > MAX_FEEDBACK_REPORTS) throw contractError("Feedback list response contains too many reports");
}

/** @param {JsonObject} body @returns {{ has_more: boolean; next_cursor?: string }} */
function parseListPagination(body) {
  if (typeof body.has_more !== "boolean") throw contractError("Feedback list response has invalid pagination state");
  if (body.next_cursor !== undefined) printableString(body.next_cursor, 512, "Feedback list cursor");
  return { has_more: body.has_more, ...(body.next_cursor === undefined ? {} : { next_cursor: body.next_cursor }) };
}

/**
 * @param {unknown} value
 * @returns {FeedbackReport}
 */
export function parseFeedbackReport(value) {
  const report = record(value, "Feedback report");
  keys(report, REPORT_REQUIRED_KEYS, REPORT_OPTIONAL_KEYS, "Feedback report");
  if (report.schema_version !== FEEDBACK_REPORT_SCHEMA) throw contractError("Feedback report schema version is unsupported");
  const id = parseFeedbackId(report.id);
  const tenantId = parseFeedbackId(report.tenant_id);
  const category = enumValue(report.category, ["bug", "feature_request", "other"], "Feedback category");
  const source = enumValue(report.source, ["embedded", "chalk_web", "chalk_mobile", "dashboard"], "Feedback source");
  const submitterKind = enumValue(report.submitter_kind, ["account", "participant"], "Feedback submitter kind");
  const message = boundedString(report.message, MAX_FEEDBACK_MESSAGE_BYTES, "Feedback message");
  const correlations = parseFeedbackCorrelations(report.correlations);
  const evidence = parseFeedbackEvidenceState(report.evidence);
  const createdAt = dateString(report.created_at, "Feedback created_at");
  const submittedAt = dateString(report.submitted_at, "Feedback submitted_at");
  const result = { schema_version: FEEDBACK_REPORT_SCHEMA, id, tenant_id: tenantId, category, source, message, submitter_kind: submitterKind, correlations, evidence, created_at: createdAt, submitted_at: submittedAt };
  return { ...result, ...parseReportOptionalFields(report) };
}

/** @param {JsonObject} report */
function parseReportOptionalFields(report) {
  return { ...parseReportOptionalStrings(report), ...parseReportOptionalIds(report), ...parseReportOptionalReference(report) };
}

/** @param {JsonObject} report */
function parseReportOptionalStrings(report) {
  const result = {};
  for (const key of ["environment", "audience"]) if (report[key] !== undefined) result[key] = printableString(report[key], 128, `Feedback ${key}`);
  return result;
}

/** @param {JsonObject} report */
function parseReportOptionalIds(report) {
  const result = {};
  for (const key of ["space_id", "episode_id", "participant_id"]) if (report[key] !== undefined) result[key] = parseFeedbackId(report[key]);
  return result;
}

/** @param {JsonObject} report */
function parseReportOptionalReference(report) {
  return report.diagnostic_reference === undefined ? {} : { diagnostic_reference: parseDiagnosticReference(report.diagnostic_reference) };
}

/**
 * Parse a downloaded Feedback Evidence object. The closed top-level schema is
 * intentional: a future field must be added to the operator parser before it
 * can reach a local file or terminal.
 *
 * @param {unknown} value
 * @returns {FeedbackEvidence}
 */
export function parseFeedbackEvidence(value) {
  const evidence = record(value, "Feedback evidence");
  keys(evidence, EVIDENCE_REQUIRED_KEYS, EVIDENCE_OPTIONAL_KEYS, "Feedback evidence");
  if (evidence.schema_version !== FEEDBACK_EVIDENCE_SCHEMA) throw contractError("Feedback evidence schema version is unsupported");
  const result = {
    schema_version: FEEDBACK_EVIDENCE_SCHEMA,
    collected_at: dateString(evidence.collected_at, "Feedback evidence collected_at"),
    sdk: parseSDK(evidence.sdk),
    platform: parsePlatform(evidence.platform),
    correlations: parseFeedbackCorrelations(evidence.correlations),
    diagnostics: parseDiagnostics(evidence.diagnostics),
    local_state: parseLocalState(evidence.local_state),
    cookies: parseCookies(evidence.cookies),
    screenshot: parseScreenshotState(evidence.screenshot),
  };
  return { ...result, ...parseEvidenceOptionalFields(evidence) };
}

/** @param {JsonObject} evidence */
function parseEvidenceOptionalFields(evidence) {
  const result = {};
  if (evidence.app !== undefined) result.app = parseApp(evidence.app);
  if (evidence.connection !== undefined) result.connection = parseConnection(evidence.connection);
  if (evidence.scope !== undefined) result.scope = parseScope(evidence.scope);
  return result;
}

/** @param {Uint8Array | ArrayBuffer | string} value @returns {FeedbackEvidenceBytes} */
export function parseFeedbackEvidenceBytes(value) {
  const bytes = evidenceBytes(value);
  validateEvidenceSize(bytes);
  return { value: parseFeedbackEvidence(decodeEvidence(bytes)), bytes };
}

/** @param {Uint8Array | ArrayBuffer | string} value @returns {Uint8Array} */
function evidenceBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  throw contractError("Feedback evidence download exceeds the size limit", "size_limit");
}

/** @param {Uint8Array} bytes */
function validateEvidenceSize(bytes) {
  if (bytes.byteLength > MAX_FEEDBACK_EVIDENCE_BYTES) throw contractError("Feedback evidence download exceeds the size limit", "size_limit");
}

/** @param {Uint8Array} bytes */
function decodeEvidence(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw contractError("Feedback evidence download is not valid JSON", "invalid_contract", error);
  }
}

/** @param {unknown} value @returns {FeedbackEvidenceState} */
function parseFeedbackEvidenceState(value) {
  const state = record(value, "Feedback evidence state");
  keys(state, ["size", "sha256", "screenshot"], ["failure_code"], "Feedback evidence state");
  return { ...parseEvidenceSize(state), ...parseEvidenceChecksum(state), ...parseEvidenceScreenshot(state), ...parseEvidenceFailure(state) };
}

/** @param {JsonObject} state */
function parseEvidenceSize(state) {
  if (!Number.isSafeInteger(state.size) || state.size < 0 || state.size > MAX_FEEDBACK_EVIDENCE_BYTES) throw contractError("Feedback evidence size is invalid");
  return { size: state.size };
}

/** @param {JsonObject} state */
function parseEvidenceChecksum(state) {
  const sha256 = state.sha256;
  if (!isValidChecksum(sha256)) throw contractError("Feedback evidence checksum is invalid");
  return { sha256 };
}

/** @param {unknown} value */
function isValidChecksum(value) {
  if (!isChecksumShape(value)) return false;
  if (!HEX_PATTERN.test(value)) return false;
  return value === value.toLowerCase();
}

/** @param {unknown} value */
function isChecksumShape(value) {
  return typeof value === "string" && value.length === 64;
}

/** @param {JsonObject} state */
function parseEvidenceScreenshot(state) {
  if (typeof state.screenshot !== "boolean") throw contractError("Feedback screenshot state is invalid");
  return { screenshot: state.screenshot };
}

/** @param {JsonObject} state */
function parseEvidenceFailure(state) {
  return state.failure_code === undefined ? {} : { failure_code: enumValue(state.failure_code, ["capture_failed", "unsupported", "tainted", "secure_surface", "too_large"], "Feedback screenshot failure") };
}

/** @param {unknown} value @returns {FeedbackCorrelations} */
export function parseFeedbackCorrelations(value) {
  const correlations = record(value, "Feedback correlations");
  keys(correlations, [], CORRELATION_KEYS, "Feedback correlations");
  return { ...parseCorrelationIds(correlations), ...parseCorrelationTokens(correlations), ...parseCorrelationTrace(correlations), ...parseCorrelationReference(correlations) };
}

/** @param {JsonObject} correlations */
function parseCorrelationIds(correlations) {
  const result = {};
  for (const key of ["journey_id", "root_journey_id"]) if (correlations[key] !== undefined) result[key] = parseFeedbackId(correlations[key]);
  return result;
}

/** @param {JsonObject} correlations */
function parseCorrelationTokens(correlations) {
  const result = {};
  for (const key of ["request_id", "command_id"]) if (correlations[key] !== undefined) result[key] = safeToken(correlations[key], `Feedback ${key}`);
  return result;
}

/** @param {JsonObject} correlations */
function parseCorrelationTrace(correlations) {
  return {
    ...(correlations.trace_id === undefined ? {} : { trace_id: hexId(correlations.trace_id, 32, "Feedback trace_id") }),
    ...(correlations.span_id === undefined ? {} : { span_id: hexId(correlations.span_id, 16, "Feedback span_id") }),
  };
}

/** @param {JsonObject} correlations */
function parseCorrelationReference(correlations) {
  return correlations.diagnostic_reference === undefined ? {} : { diagnostic_reference: parseDiagnosticReference(correlations.diagnostic_reference) };
}

/** @param {unknown} value @returns {FeedbackSDK} */
function parseSDK(value) {
  const sdk = record(value, "Feedback SDK");
  keys(sdk, ["client"], ["react", "react_native"], "Feedback SDK");
  const result = { client: printableString(sdk.client, 128, "Feedback SDK client") };
  for (const key of ["react", "react_native"]) if (sdk[key] !== undefined) result[key] = printableString(sdk[key], 128, `Feedback SDK ${key}`);
  return result;
}

/** @param {unknown} value @returns {FeedbackPlatform} */
function parsePlatform(value) {
  const platform = record(value, "Feedback platform");
  keys(platform, ["kind"], ["os_name", "os_version", "browser_name", "browser_version", "device_class", "device_model"], "Feedback platform");
  const result = { kind: enumValue(platform.kind, ["web", "ios", "android", "macos"], "Feedback platform kind") };
  for (const key of ["os_name", "os_version", "browser_name", "browser_version", "device_model"]) if (platform[key] !== undefined) result[key] = printableString(platform[key], 128, `Feedback platform ${key}`);
  if (platform.device_class !== undefined) result.device_class = enumValue(platform.device_class, ["phone", "tablet", "desktop"], "Feedback device class");
  return result;
}

/** @param {unknown} value @returns {FeedbackApp} */
function parseApp(value) {
  const app = record(value, "Feedback app");
  keys(app, ["name"], ["version", "build"], "Feedback app");
  const result = { name: printableString(app.name, 128, "Feedback app name") };
  for (const key of ["version", "build"]) if (app[key] !== undefined) result[key] = printableString(app[key], 128, `Feedback app ${key}`);
  return result;
}

/** @param {unknown} value @returns {FeedbackConnection} */
function parseConnection(value) {
  const connection = record(value, "Feedback connection");
  keys(connection, ["state"], ["error_code"], "Feedback connection");
  const result = { state: printableString(connection.state, 128, "Feedback connection state") };
  if (connection.error_code !== undefined) result.error_code = safeToken(connection.error_code, "Feedback connection error_code");
  return result;
}

/** @param {unknown} value @returns {FeedbackScope} */
function parseScope(value) {
  const scope = record(value, "Feedback scope");
  keys(scope, [], ["space_id", "episode_id", "participant_id"], "Feedback scope");
  const result = {};
  for (const key of ["space_id", "episode_id", "participant_id"]) if (scope[key] !== undefined) result[key] = parseFeedbackId(scope[key]);
  return result;
}

/** @param {unknown} value @returns {FeedbackDiagnostics} */
function parseDiagnostics(value) {
  const diagnostics = record(value, "Feedback diagnostics");
  keys(diagnostics, ["availability", "dropped_count", "telemetry_events", "diagnostic_events"], [], "Feedback diagnostics");
  const result = {
    availability: enumValue(diagnostics.availability, ["available", "disabled", "disposed", "unavailable"], "Feedback diagnostics availability"),
    dropped_count: boundedInteger(diagnostics.dropped_count, 0, 1_000_000, "Feedback diagnostics dropped_count"),
    telemetry_events: boundedEvents(diagnostics.telemetry_events, "Feedback telemetry_events"),
    diagnostic_events: boundedEvents(diagnostics.diagnostic_events, "Feedback diagnostic_events"),
  };
  return result;
}

/** @param {unknown} value @param {string} label @returns {JsonValue[]} */
function boundedEvents(value, label) {
  if (!Array.isArray(value) || value.length > 50) throw contractError(`${label} exceeds the event limit`);
  return value.map((entry) => boundedJSON(entry, label, 3));
}

/** @param {unknown} value @returns {FeedbackLocalState} */
function parseLocalState(value) {
  const state = record(value, "Feedback local_state");
  keys(state, ["registry_version", "entries"], [], "Feedback local_state");
  if (state.registry_version !== "FeedbackLocalState/v1") throw contractError("Feedback local_state registry version is unsupported");
  if (!Array.isArray(state.entries) || state.entries.length > 32) throw contractError("Feedback local_state contains too many entries");
  return { registry_version: state.registry_version, entries: state.entries.map((entry) => parseStateEntry(entry)) };
}

/** @param {unknown} value @returns {FeedbackStateEntry} */
function parseStateEntry(value) {
  const entry = record(value, "Feedback local_state entry");
  keys(entry, ["key", "value"], [], "Feedback local_state entry");
  return { key: printableString(entry.key, 256, "Feedback local_state key"), value: boundedJSON(entry.value, "Feedback local_state value", 3) };
}

/** @param {unknown} value @returns {FeedbackCookies} */
function parseCookies(value) {
  const cookies = record(value, "Feedback cookies");
  keys(cookies, ["registry_version", "entries"], [], "Feedback cookies");
  if (cookies.registry_version !== "FeedbackCookies/v1") throw contractError("Feedback cookies registry version is unsupported");
  if (!Array.isArray(cookies.entries) || cookies.entries.length > 16) throw contractError("Feedback cookies contains too many entries");
  return { registry_version: cookies.registry_version, entries: cookies.entries.map((entry) => parseCookieEntry(entry)) };
}

/** @param {unknown} value @returns {FeedbackCookie} */
function parseCookieEntry(value) {
  const entry = record(value, "Feedback cookie entry");
  keys(entry, ["name", "present"], ["value"], "Feedback cookie entry");
  if (typeof entry.present !== "boolean") throw contractError("Feedback cookie present flag is invalid");
  const result = { name: printableString(entry.name, 256, "Feedback cookie name"), present: entry.present };
  if (entry.value !== undefined) result.value = printableString(entry.value, 512, "Feedback cookie value");
  return result;
}

/** @param {unknown} value @returns {FeedbackScreenshot} */
function parseScreenshotState(value) {
  const screenshot = record(value, "Feedback screenshot state");
  keys(screenshot, ["state"], ["captured_at", "failure_code"], "Feedback screenshot state");
  const result = { state: enumValue(screenshot.state, ["captured", "partial", "removed", "unavailable"], "Feedback screenshot state") };
  if (screenshot.captured_at !== undefined) result.captured_at = dateString(screenshot.captured_at, "Feedback screenshot captured_at");
  if (screenshot.failure_code !== undefined) result.failure_code = enumValue(screenshot.failure_code, ["capture_failed", "unsupported", "tainted", "secure_surface", "too_large"], "Feedback screenshot failure");
  return result;
}

/** @param {unknown} value @param {string} label @param {number} depth @returns {JsonValue} */
function boundedJSON(value, label, depth) {
  if (depth < 0) throw contractError(`${label} is too deeply nested`);
  const primitive = boundedPrimitive(value, label);
  if (primitive !== undefined) return primitive;
  if (Array.isArray(value)) return boundedArray(value, label, depth);
  return boundedObject(value, label, depth);
}

/** @param {unknown} value @param {string} label @returns {JsonValue | undefined} */
function boundedPrimitive(value, label) {
  if (value === null) return value;
  if (typeof value === "boolean") return value;
  return boundedPrimitiveValue(value, label);
}

/** @param {unknown} value @param {string} label @returns {JsonValue | undefined} */
function boundedPrimitiveValue(value, label) {
  if (typeof value === "string") return boundedString(value, 2_048, label);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw contractError(`${label} contains a non-finite number`);
    return value;
  }
  return undefined;
}

/** @param {unknown[]} values @param {string} label @param {number} depth @returns {JsonArray} */
function boundedArray(values, label, depth) {
  if (values.length > 50) throw contractError(`${label} contains too many values`);
  return values.map((entry) => boundedJSON(entry, label, depth - 1));
}

/** @param {unknown} value @param {string} label @param {number} depth @returns {JsonObject} */
function boundedObject(value, label, depth) {
  if (!isJsonObject(value)) throw contractError(`${label} has an unsupported value`);
  const names = Object.keys(value);
  if (names.length > 32) throw contractError(`${label} contains too many fields`);
  return Object.fromEntries(names.map((name) => boundedField(value, name, label, depth)));
}

/** @param {JsonObject} object @param {string} name @param {string} label @param {number} depth @returns {[string, JsonValue]} */
function boundedField(object, name, label, depth) {
  if (!isSafeFieldName(name)) throw contractError(`${label} contains an unsafe field`);
  return [name, boundedJSON(object[name], label, depth - 1)];
}

/** @param {string} name */
function isSafeFieldName(name) {
  return isSafeFieldShape(name) && !CONTROL_PATTERN.test(name) && !FORBIDDEN_KEY_PATTERN.test(name);
}

/** @param {string} name */
function isSafeFieldShape(name) {
  return Boolean(name) && name.length <= 128;
}

/** @param {unknown} value @param {string} label */
function record(value, label) {
  if (!isJsonObject(value)) throw contractError(`${label} must be an object`);
  return value;
}

/** @param {JsonObject} value @param {readonly string[]} required @param {readonly string[]} optional @param {string} label */
function keys(value, required, optional, label) {
  validateRequiredKeys(value, required, label);
  validateAllowedKeys(value, required, optional, label);
}

/** @param {JsonObject} value @param {readonly string[]} required @param {string} label */
function validateRequiredKeys(value, required, label) {
  for (const key of required) if (!Object.hasOwn(value, key)) throw contractError(`${label} is missing ${key}`);
}

/** @param {JsonObject} value @param {readonly string[]} required @param {readonly string[]} optional @param {string} label */
function validateAllowedKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw contractError(`${label} contains an unknown field`);
}

/** @param {unknown} value @returns {value is JsonObject} */
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {number} maxBytes @param {string} label */
function boundedString(value, maxBytes, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) throw contractError(`${label} exceeds its size limit`);
  return value;
}

/** @param {unknown} value @param {number} maxBytes @param {string} label */
function printableString(value, maxBytes, label) {
  const text = boundedString(value, maxBytes, label);
  if (CONTROL_PATTERN.test(text)) throw contractError(`${label} contains control characters`);
  return text;
}

/** @param {unknown} value @param {string[]} allowed @param {string} label */
function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) throw contractError(`${label} is unsupported`);
  return value;
}

/** @param {unknown} value @param {number} minimum @param {number} maximum @param {string} label */
function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw contractError(`${label} is invalid`);
  return value;
}

/** @param {unknown} value @param {string} label */
function dateString(value, label) {
  const text = printableString(value, 64, label);
  if (Number.isNaN(Date.parse(text))) throw contractError(`${label} is invalid`);
  return text;
}

/** @param {unknown} value @param {string} label */
function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN_PATTERN.test(value)) throw contractError(`${label} is invalid`);
  return value;
}

/** @param {unknown} value @param {number} digits @param {string} label */
function hexId(value, digits, label) {
  const text = hexText(value, digits, label);
  if (text !== text.toLowerCase()) throw contractError(`${label} is invalid`);
  if (/^0+$/u.test(text)) throw contractError(`${label} is invalid`);
  return text;
}

/** @param {unknown} value @param {number} digits @param {string} label @returns {string} */
function hexText(value, digits, label) {
  if (typeof value !== "string" || value.length !== digits || !HEX_PATTERN.test(value)) throw contractError(`${label} is invalid`);
  return value;
}

/** @param {unknown} value */
function parseDiagnosticReference(value) {
  try {
    return formatDiagnosticReference(parseReference(value));
  } catch (error) {
    throw contractError("Feedback diagnostic reference is invalid", "invalid_contract", error);
  }
}

/** @param {import("./reference.mjs").DiagnosticReference} reference */
function formatDiagnosticReference(reference) {
  let value = `chalkdiag:v1:${reference.environment}:${reference.diagnosticId}`;
  if (reference.focus) value += `:${reference.focus.kind}:${reference.focus.id}`;
  if (reference.cursor !== undefined) value += `@${reference.cursor}`;
  return value;
}

/** @param {string} message @param {string} [code] @param {unknown} [cause] */
function contractError(message, code = "invalid_contract", cause = undefined) {
  return new DiagnosticInspectError(code, message, cause === undefined ? undefined : { cause });
}
