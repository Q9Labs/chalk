// @ts-check

import { buildAgentBrief, formatCompactBrief, formatMarkdownBrief } from "./brief.mjs";
import { createDiagnosticClient } from "./client.mjs";
import { DiagnosticInspectError } from "./errors.mjs";
import { parseReference } from "./reference.mjs";
import { sanitizeDiagnosticData } from "./safety.mjs";

const QUERY_NAMES = new Set(["summary", "focus", "brief", "copy-all", "events", "operations", "graph", "flame", "participants", "epilogue"]);
const PAGE_QUERIES = new Set(["events", "operations"]);
const PROJECTION_QUERIES = new Set(["graph", "flame", "participants", "epilogue"]);
const CURSOR_QUERY_KEYS = ["atCursor", "cursor", "afterCursor", "beforeCursor"];
const FOCUS_COLLECTION_KEYS = { op: "operations", issue: "issues", event: "events" };
const FOCUS_KEYS = ["operation", "issue", "event"];
const FOCUS_IDENTIFIER_KEYS = ["id", "eventId", "cursor"];
const EXPIRED_BODY_KEYS = ["state", "code", "reason"];
const MAX_OVERVIEW_OPERATIONS = 24;
const MAX_OVERVIEW_ISSUES = 24;
const MAX_OVERVIEW_BRANCHES = 24;
const MAX_OVERVIEW_PARTICIPANTS = 100;

/**
 * Resolve one opaque Diagnostic Reference through the same snapshot, brief,
 * and paged contracts used by the internal debugger. The function returns
 * sanitized machine data; renderers decide whether it becomes text, Markdown,
 * or JSON.
 *
 * @param {string} referenceValue
 * @param {Record<string, any>} [query]
 */
export async function inspectDiagnostic(referenceValue, query = {}) {
  const reference = parseReference(referenceValue);
  const normalized = normalizeQuery(query);
  assertEnvironment(reference, requestedEnvironment(query));
  const client = await resolveClient(query);
  assertEnvironment(reference, clientEnvironment(client));

  if (isBriefQuery(normalized)) {
    return inspectBrief(client, referenceValue, reference, normalized);
  }
  if (PAGE_QUERIES.has(normalized.query)) {
    return inspectPage(client, referenceValue, reference, normalized);
  }
  return inspectSnapshot(client, referenceValue, reference, normalized);
}

/**
 * @param {Record<string, any>} query
 */
function normalizeQuery(query) {
  const format = normalizeFormat(query.format);
  const requestedQuery = normalizeQueryName(query);
  const aroundValue = query.aroundSeconds ?? query.around;
  const aroundSeconds = normalizeAroundSeconds(aroundValue);
  const limit = normalizeLimit(query.limit ?? query.pageSize ?? 100);
  const cursors = normalizeCursors(query);
  validateBranchId(query.branchId);
  return {
    format,
    query: requestedQuery,
    aroundSeconds,
    branchId: query.branchId,
    ...cursors,
    latest: query.latest === true,
    limit,
  };
}

/** @param {unknown} value */
function normalizeFormat(value) {
  const format = value ?? "text";
  if (!["text", "agent", "json"].includes(format)) throw new DiagnosticInspectError("invalid_query", "Format must be text, agent, or json");
  return format;
}

/** @param {Record<string, any>} query */
function normalizeQueryName(query) {
  const requested = requestedQueryName(query);
  if (typeof requested !== "string") throw new DiagnosticInspectError("invalid_query", "Diagnostic query is not supported");
  if (!QUERY_NAMES.has(requested)) throw new DiagnosticInspectError("invalid_query", "Diagnostic query is not supported");
  return requested;
}

/** @param {Record<string, any>} query */
function requestedQueryName(query) {
  const explicit = explicitQueryName(query);
  if (explicit !== undefined) return explicit;
  return legacyQueryName(query) ?? "summary";
}

/** @param {Record<string, any>} query */
function explicitQueryName(query) {
  return query.query ?? query.view ?? query.page;
}

/** @param {Record<string, any>} query */
function legacyQueryName(query) {
  if (query.brief) return "brief";
  if (query.copyAll) return "copy-all";
  return undefined;
}

/** @param {unknown} value */
function normalizeAroundSeconds(value) {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!isBoundedSeconds(seconds)) throw new DiagnosticInspectError("invalid_query", "Around window must be between 0 and 3600 seconds");
  return seconds;
}

/** @param {number} seconds */
function isBoundedSeconds(seconds) {
  return Number.isFinite(seconds) && Math.min(Math.max(seconds, 0), 3_600) === seconds;
}

/** @param {unknown} value */
function normalizeLimit(value) {
  const limit = Number(value);
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= 1_000;
  if (!valid) throw new DiagnosticInspectError("invalid_query", "Page size must be an integer between 1 and 1000");
  return limit;
}

/** @param {Record<string, any>} query */
function normalizeCursors(query) {
  for (const key of CURSOR_QUERY_KEYS) validateCursor(query[key], key);
  return {
    atCursor: query.atCursor ?? query.cursor,
    afterCursor: query.afterCursor,
    beforeCursor: query.beforeCursor,
  };
}

/** @param {unknown} value @param {string} key */
function validateCursor(value, key) {
  if (value === undefined) return;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new DiagnosticInspectError("invalid_query", `${key} must be a non-negative safe cursor`);
}

/** @param {unknown} value */
function validateBranchId(value) {
  if (value === undefined) return;
  if (typeof value !== "string") throw new DiagnosticInspectError("invalid_query", "Branch ID is not safe");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) throw new DiagnosticInspectError("invalid_query", "Branch ID is not safe");
}

/** @param {import("./reference.mjs").DiagnosticReference} reference @param {unknown} environment */
function assertEnvironment(reference, environment) {
  if (environment !== undefined && environment !== reference.environment) throw new DiagnosticInspectError("cross_environment", "Diagnostic reference belongs to a different environment");
}

/** @param {Record<string, any>} query */
function requestedEnvironment(query) {
  return query.environment ?? query.env;
}

/** @param {Record<string, any>} client */
function clientEnvironment(client) {
  return client.config?.environment;
}

/** @param {Record<string, any>} query */
async function resolveClient(query) {
  if (query.client) return query.client;
  return createDiagnosticClient({
    config: query.config,
    baseUrl: query.baseUrl,
    environment: query.environment,
    credential: query.credential,
    credentialFile: query.credentialFile,
    fetchImpl: query.fetchImpl ?? query.fetch,
  });
}

/** @param {ReturnType<typeof normalizeQuery>} query */
function isBriefQuery(query) {
  return query.query === "brief" || query.query === "copy-all" || query.format === "agent";
}

/**
 * @param {ReturnType<typeof createDiagnosticClient> extends Promise<infer T> ? T : never} client
 * @param {string} referenceValue
 * @param {import("./reference.mjs").DiagnosticReference} reference
 * @param {ReturnType<typeof normalizeQuery>} query
 */
async function inspectSnapshot(client, referenceValue, reference, query) {
  const response = await client.snapshot(referenceValue);
  const resolved = resolveSnapshotResponse(response.body, referenceValue, reference);
  assertSnapshotFresh(resolved.snapshot);
  if (PROJECTION_QUERIES.has(query.query)) return inspectProjection(client, referenceValue, reference, resolved.snapshot, query);
  return buildOverview(resolved.snapshot, referenceValue, reference, resolved.focus, query);
}

/**
 * @param {ReturnType<typeof createDiagnosticClient> extends Promise<infer T> ? T : never} client
 * @param {string} referenceValue
 * @param {import("./reference.mjs").DiagnosticReference} reference
 * @param {ReturnType<typeof normalizeQuery>} query
 */
async function inspectBrief(client, referenceValue, reference, query) {
  let response;
  try {
    response = await client.brief(referenceValue, query);
  } catch (error) {
    return fallbackBrief(client, referenceValue, reference, query, error);
  }
  return formatBriefResponse(response.body, referenceValue, query);
}

/**
 * @param {ReturnType<typeof createDiagnosticClient> extends Promise<infer T> ? T : never} client
 * @param {string} referenceValue
 * @param {import("./reference.mjs").DiagnosticReference} reference
 * @param {ReturnType<typeof normalizeQuery>} query
 * @param {unknown} error
 */
async function fallbackBrief(client, referenceValue, reference, query, error) {
  const inspectError = asInspectError(error);
  if (inspectError.code !== "not_found") throw inspectError;
  const snapshotResponse = await client.snapshot(referenceValue);
  const resolved = resolveSnapshotResponse(snapshotResponse.body, referenceValue, reference);
  assertSnapshotFresh(resolved.snapshot);
  const brief = buildAgentBrief(resolved.snapshot, { reference, focus: resolved.focus, cursor: query.atCursor, aroundSeconds: query.aroundSeconds, branchId: query.branchId });
  return query.query === "copy-all" ? fallbackMarkdownBrief(referenceValue, brief) : fallbackCompactBrief(referenceValue, brief);
}

/** @param {unknown} error */
function asInspectError(error) {
  return error instanceof DiagnosticInspectError ? error : new DiagnosticInspectError("transport", "Diagnostic service could not be reached");
}

/** @param {string} referenceValue @param {Record<string, unknown>} brief */
function fallbackMarkdownBrief(referenceValue, brief) {
  return { kind: "brief", format: "markdown", reference: referenceValue, brief, markdown: formatMarkdownBrief(brief) };
}

/** @param {string} referenceValue @param {Record<string, unknown>} brief */
function fallbackCompactBrief(referenceValue, brief) {
  return { kind: "brief", format: "compact", reference: referenceValue, brief, text: formatCompactBrief(brief) };
}

/** @param {Record<string, unknown>} body @param {string} referenceValue @param {ReturnType<typeof normalizeQuery>} query */
function formatBriefResponse(body, referenceValue, query) {
  assertSnapshotFresh(body);
  const brief = briefFromBody(body);
  const markdown = markdownFromBody(body, brief);
  const format = briefFormat(query);
  return {
    kind: "brief",
    format,
    reference: referenceValue,
    brief,
    ...briefOutput(format, brief, markdown),
  };
}

/** @param {Record<string, unknown>} body */
function briefFromBody(body) {
  return body.brief && typeof body.brief === "object" ? /** @type {Record<string, unknown>} */ (body.brief) : body;
}

/** @param {Record<string, unknown>} _body @param {Record<string, unknown>} brief */
function markdownFromBody(_body, brief) {
  return formatMarkdownBrief(brief);
}

/** @param {ReturnType<typeof normalizeQuery>} query */
function briefFormat(query) {
  if (query.query === "copy-all") return "markdown";
  if (query.format === "json") return "json";
  return "compact";
}

/** @param {string} format @param {Record<string, unknown>} brief @param {string} markdown */
function briefOutput(format, brief, markdown) {
  if (format === "compact") return { text: formatCompactBrief(brief) };
  if (format === "markdown") return { markdown };
  return {};
}

/**
 * @param {ReturnType<typeof createDiagnosticClient> extends Promise<infer T> ? T : never} client
 * @param {string} referenceValue
 * @param {import("./reference.mjs").DiagnosticReference} reference
 * @param {ReturnType<typeof normalizeQuery>} query
 */
async function inspectPage(client, referenceValue, reference, query) {
  const response = await client.page(referenceValue, query.query, query);
  const body = response.body;
  assertSnapshotFresh(body);
  const collectionKey = query.query;
  const collection = pageCollection(body, collectionKey);
  const page = buildPage(body, referenceValue, collectionKey, collection, query);
  const focus = resolveFocusFromCollection(page[collectionKey], reference);
  assertFocusFound(reference, focus);
  return { kind: "page", page, ...focusField(focus) };
}

/** @param {Record<string, unknown>} body @param {string} key */
function pageCollection(body, key) {
  if (Array.isArray(body[key])) return body[key];
  if (Array.isArray(body.items)) return body.items;
  return [];
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} referenceValue
 * @param {string} collectionKey
 * @param {unknown[]} collection
 * @param {ReturnType<typeof normalizeQuery>} query
 */
function buildPage(body, referenceValue, collectionKey, collection, query) {
  const nextCursor = numberOrUndefined(body.nextCursor);
  return {
    schemaVersion: pageSchemaVersion(collectionKey),
    reference: referenceValue,
    [collectionKey]: collection.slice(0, query.limit),
    committedCursor: numberOr(body.committedCursor, 0),
    projectedCursor: numberOr(body.projectedCursor, 0),
    ...optionalCursorField("nextCursor", nextCursor),
    hasMore: body.hasMore === true || nextCursor !== undefined,
    filterFingerprint: typeof body.filterFingerprint === "string" ? body.filterFingerprint : "fixture",
    ...optionalCursorField("afterCursor", numberOrUndefined(query.afterCursor)),
    ...optionalCursorField("beforeCursor", numberOrUndefined(query.beforeCursor)),
  };
}

/** @param {string} collectionKey */
function pageSchemaVersion(collectionKey) {
  return collectionKey === "events" ? "DiagnosticEventPage/v1" : "DiagnosticOperationPage/v1";
}

/** @param {string} key @param {number | undefined} value */
function optionalCursorField(key, value) {
  return value === undefined ? {} : { [key]: numberOr(value, 0) };
}

/** @param {import("./reference.mjs").DiagnosticReference} reference @param {unknown} focus */
function assertFocusFound(reference, focus) {
  if (reference.focus && !focus) throw new DiagnosticInspectError("not_found", "Focused diagnostic item was not found");
}

/**
 * @param {ReturnType<typeof createDiagnosticClient> extends Promise<infer T> ? T : never} client
 * @param {string} referenceValue
 * @param {import("./reference.mjs").DiagnosticReference} reference
 * @param {Record<string, unknown>} snapshot
 * @param {ReturnType<typeof normalizeQuery>} query
 */
async function inspectProjection(client, referenceValue, reference, snapshot, query) {
  const response = await client.projection(referenceValue, query.query, query);
  const body = response.body;
  assertSnapshotFresh(body);
  const projection = projectionFromBody(body, snapshot, query.query);
  assertProjection(projection, query.query);
  return {
    kind: query.query,
    reference: referenceValue,
    schemaVersion: `Diagnostic${capitalize(query.query)}/v1`,
    projection: sanitizeDiagnosticData(projection),
    committedCursor: numberOr(body.committedCursor ?? snapshot.committedCursor, 0),
    projectedCursor: numberOr(body.projectedCursor ?? snapshot.projectedCursor, 0),
  };
}

/** @param {Record<string, unknown>} body @param {Record<string, unknown>} snapshot @param {string} key */
function projectionFromBody(body, snapshot, key) {
  const direct = body[key];
  if (direct && typeof direct === "object") return direct;
  if (body.schemaVersion) return body;
  return snapshot[key];
}

/** @param {unknown} projection @param {string} key */
function assertProjection(projection, key) {
  if (!projection || typeof projection !== "object") throw new DiagnosticInspectError("not_found", `Diagnostic ${key} projection is not available`);
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} referenceValue
 * @param {import("./reference.mjs").DiagnosticReference} reference
 */
function resolveSnapshotResponse(body, referenceValue, reference) {
  assertUnambiguousBody(body);
  assertSnapshotFresh(body);
  const snapshot = snapshotFromBody(body);
  assertSnapshotObject(snapshot);
  assertEnvironment(reference, snapshot.environment);
  const focus = directFocus(body) ?? resolveFocus(snapshot, reference);
  assertFocusFound(reference, focus);
  return { snapshot: /** @type {Record<string, unknown>} */ (sanitizeDiagnosticData(snapshot)), ...(focus ? { focus } : {}) };
}

/** @param {Record<string, unknown>} body */
function assertUnambiguousBody(body) {
  if (body.kind === "ambiguous" || body.code === "ambiguous") throw new DiagnosticInspectError("ambiguous", "Diagnostic reference resolved to more than one focus");
}

/** @param {Record<string, unknown>} body */
function snapshotFromBody(body) {
  return body.snapshot && typeof body.snapshot === "object" ? body.snapshot : body;
}

/** @param {unknown} snapshot */
function assertSnapshotObject(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new DiagnosticInspectError("server", "Diagnostic snapshot was invalid");
}

/** @param {Record<string, unknown>} snapshot */
function assertSnapshotFresh(snapshot) {
  if (isExpiredBody(snapshot)) throw new DiagnosticInspectError("expired", "Diagnostic data has expired");
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {string} referenceValue
 * @param {import("./reference.mjs").DiagnosticReference} reference
 * @param {Record<string, unknown> | undefined} focus
 * @param {ReturnType<typeof normalizeQuery>} query
 */
function buildOverview(snapshot, referenceValue, reference, focus, query) {
  const bounded = boundedSnapshot(snapshot);
  return {
    ...overviewMetadata(snapshot, referenceValue, reference),
    summary: overviewSummary(snapshot),
    ...focusField(focus),
    snapshot: bounded,
    issues: bounded.issues,
    operations: bounded.operations,
    branches: bounded.branches,
    gaps: snapshot.gaps ?? snapshot.visibleGaps ?? [],
    availableQueries: ["events", "operations", "graph", "flame", "participants", "epilogue", "brief", "copy-all"],
    ...aroundField(query.aroundSeconds),
  };
}

/** @param {Record<string, unknown>} snapshot @param {string} referenceValue @param {import("./reference.mjs").DiagnosticReference} reference */
function overviewMetadata(snapshot, referenceValue, reference) {
  return {
    schemaVersion: "DiagnosticOverview/v1",
    kind: "overview",
    reference: referenceValue,
    environment: snapshot.environment ?? reference.environment,
    state: snapshot.state ?? "unknown",
    capturedAt: snapshot.capturedAt ?? undefined,
    committedCursor: numberOr(snapshot.committedCursor, 0),
    projectedCursor: numberOr(snapshot.projectedCursor, 0),
    ...optionalCursorField("runEndCursor", numberOrUndefined(snapshot.runEndCursor)),
  };
}

/** @param {Record<string, unknown>} snapshot */
function overviewSummary(snapshot) {
  return snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : {};
}

/** @param {unknown} focus */
function focusField(focus) {
  return focus ? { focus } : {};
}

/** @param {number | undefined} aroundSeconds */
function aroundField(aroundSeconds) {
  return aroundSeconds === undefined ? {} : { aroundSeconds };
}

/** @param {Record<string, any>} snapshot */
function boundedSnapshot(snapshot) {
  return {
    ...snapshot,
    operations: boundedArray(snapshot.operations, MAX_OVERVIEW_OPERATIONS),
    issues: boundedArray(snapshot.issues, MAX_OVERVIEW_ISSUES),
    branches: boundedArray(snapshot.branches, MAX_OVERVIEW_BRANCHES),
    participants: boundedArray(snapshot.participants, MAX_OVERVIEW_PARTICIPANTS),
    events: undefined,
  };
}

/** @param {unknown} value @param {number} limit */
function boundedArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

/** @param {unknown} value */
function isExpiredBody(value) {
  if (!value || typeof value !== "object") return false;
  const body = /** @type {Record<string, unknown>} */ (value);
  return EXPIRED_BODY_KEYS.some((key) => body[key] === "expired");
}

/** @param {Record<string, unknown>} body */
function directFocus(body) {
  for (const key of FOCUS_KEYS) {
    const focus = body[key];
    if (focus && typeof focus === "object") return focus;
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {import("./reference.mjs").DiagnosticReference} reference
 */
function resolveFocus(snapshot, reference) {
  if (!reference.focus) return undefined;
  const collectionKey = FOCUS_COLLECTION_KEYS[reference.focus.kind];
  const collection = Array.isArray(snapshot[collectionKey]) ? snapshot[collectionKey] : [];
  return resolveFocusFromCollection(collection, reference);
}

/**
 * @param {unknown} collection
 * @param {import("./reference.mjs").DiagnosticReference} reference
 */
function resolveFocusFromCollection(collection, reference) {
  if (!reference.focus || !Array.isArray(collection)) return undefined;
  const matches = collection.filter((item) => isFocusMatch(item, reference.focus));
  if (matches.length > 1) throw new DiagnosticInspectError("ambiguous", "Focused diagnostic item is ambiguous");
  return matches[0];
}

/** @param {unknown} item @param {{ kind: string; id: string }} focus */
function isFocusMatch(item, focus) {
  if (!item || typeof item !== "object") return false;
  return matchesFocusIdentifier(/** @type {Record<string, unknown>} */ (item), focus);
}

/** @param {Record<string, unknown>} item @param {{ kind: string; id: string }} focus */
function matchesFocusIdentifier(item, focus) {
  if (FOCUS_IDENTIFIER_KEYS.some((key) => item[key] === focus.id)) return true;
  const itemReference = item.reference;
  return typeof itemReference === "string" && itemReference.includes(`:${focus.kind}:${focus.id}`);
}

/** @param {unknown} value @param {number} fallback */
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** @param {unknown} value */
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** @param {string} value */
function capitalize(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export { normalizeQuery, boundedSnapshot, resolveFocus };
