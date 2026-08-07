// @ts-check

import { asDiagnosticInspectError, DiagnosticInspectError } from "./errors.mjs";
import { resolveOperatorConfig } from "./config.mjs";
import { sanitizeDiagnosticData } from "./safety.mjs";

const BODY_ERROR_CODES = Object.freeze({
  unauthorized: "unauthorized",
  "operator.unauthorized": "unauthorized",
  not_found: "not_found",
  "diagnostic.not_found": "not_found",
  ambiguous: "ambiguous",
  "diagnostic.ambiguous": "ambiguous",
  expired: "expired",
  "diagnostic.expired": "expired",
});
const STATUS_ERROR_CODES = Object.freeze({ 401: "unauthorized", 403: "unauthorized", 404: "not_found", 409: "ambiguous", 410: "expired" });
const ERROR_MESSAGES = Object.freeze({
  unauthorized: "Diagnostic operator authorization was denied",
  not_found: "Diagnostic was not found",
  ambiguous: "Diagnostic reference resolved to more than one focus",
  expired: "Diagnostic data has expired",
  server: "Diagnostic service returned an unavailable response",
});

/**
 * @typedef {{ config?: import("./config.mjs").DiagnosticOperatorConfig; baseUrl?: string; environment?: string; credential?: string; credentialFile?: string; fetchImpl?: typeof fetch; fetch?: typeof fetch }} DiagnosticClientOptions
 */

/**
 * @typedef {{ body: Record<string, unknown>; status: number; url: string }} DiagnosticResponse
 */

/**
 * @param {DiagnosticClientOptions} [options]
 */
export async function createDiagnosticClient(options = {}) {
  const config = await resolveClientConfig(options);
  const fetchImpl = fetchImplementation(options, config);
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const headers = requestHeaders(config.credential);
  return {
    config: { ...config, fetchImpl: undefined },
    async snapshot(reference) {
      return requestFirst(fetchImpl, headers, baseUrl, [`${pathFor(reference)}`, `${pathFor(reference)}/snapshot`]);
    },
    async brief(reference, query = {}) {
      return request(fetchImpl, headers, `${baseUrl}${pathFor(reference)}/brief`, { query: queryParams(query) });
    },
    async page(reference, kind, query = {}) {
      return request(fetchImpl, headers, `${baseUrl}${pathFor(reference)}/${kind}`, { query: queryParams(query) });
    },
    async projection(reference, kind, query = {}) {
      return requestFirst(fetchImpl, headers, baseUrl, [`${pathFor(reference)}/${kind}`, pathFor(reference)], { query: queryParams(query) });
    },
  };
}

/**
 * @param {DiagnosticClientOptions} options
 */
async function resolveClientConfig(options) {
  if (options.config) return options.config;
  return resolveOperatorConfig({ ...options, fetchImpl: options.fetchImpl ?? options.fetch });
}

/**
 * @param {DiagnosticClientOptions} options
 * @param {import("./config.mjs").DiagnosticOperatorConfig} config
 */
function fetchImplementation(options, config) {
  return options.fetchImpl ?? options.fetch ?? config.fetchImpl;
}

/** @param {string} baseUrl */
function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/u, "");
}

/** @param {string | undefined} credential */
function requestHeaders(credential) {
  return { Accept: "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {Record<string, string>} headers
 * @param {string} baseUrl
 * @param {string[]} paths
 * @param {{ query?: Record<string, string> }} [options]
 */
async function requestFirst(fetchImpl, headers, baseUrl, paths, options = {}) {
  let lastNotFound;
  for (const path of paths) {
    try {
      return await request(fetchImpl, headers, `${baseUrl}${path}`, options);
    } catch (error) {
      const inspectError = asDiagnosticInspectError(error);
      if (inspectError.code !== "not_found") throw inspectError;
      lastNotFound = inspectError;
    }
  }
  throw notFoundError(lastNotFound);
}

/** @param {DiagnosticInspectError | undefined} lastNotFound */
function notFoundError(lastNotFound) {
  if (lastNotFound) return lastNotFound;
  return new DiagnosticInspectError("not_found", "Diagnostic was not found");
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {Record<string, string>} headers
 * @param {string} endpoint
 * @param {{ query?: Record<string, string> }} [options]
 * @returns {Promise<DiagnosticResponse>}
 */
async function request(fetchImpl, headers, endpoint, options = {}) {
  const url = requestURL(endpoint, options.query);
  const response = await fetchResponse(fetchImpl, headers, url);
  const body = await responseBody(response);
  if (!response.ok) throw responseError(response.status, body);
  return { body, status: response.status, url: url.toString() };
}

/**
 * @param {string} endpoint
 * @param {Record<string, string> | undefined} query
 */
function requestURL(endpoint, query) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {Record<string, string>} headers
 * @param {URL} url
 */
async function fetchResponse(fetchImpl, headers, url) {
  try {
    return await fetchImpl(url, { method: "GET", headers });
  } catch (error) {
    throw new DiagnosticInspectError("transport", "Diagnostic service could not be reached", { cause: error });
  }
}

/** @param {Response} response @returns {Promise<Record<string, unknown>>} */
async function responseBody(response) {
  try {
    const parsed = await response.json();
    return discardServerMarkdown(sanitizeResponseBody(parsed));
  } catch {
    // The response body is intentionally omitted from errors to avoid leaking
    // credentials or arbitrary provider payloads.
  }
  return {};
}

/** @param {unknown} parsed @returns {Record<string, unknown>} */
function sanitizeResponseBody(parsed) {
  if (!parsed) return {};
  if (typeof parsed !== "object") return {};
  if (Array.isArray(parsed)) return {};
  return /** @type {Record<string, unknown>} */ (sanitizeDiagnosticData(parsed));
}

/** @param {Record<string, unknown>} body */
function discardServerMarkdown(body) {
  if (body.schemaVersion !== "AgentBriefResponse/v1") return body;
  const { markdown: _markdown, ...structured } = body;
  return structured;
}

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function responseError(status, body) {
  const code = responseErrorCode(status, body);
  const message = ERROR_MESSAGES[code] ?? `Diagnostic service returned HTTP ${status}`;
  return new DiagnosticInspectError(code, message);
}

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function responseErrorCode(status, body) {
  const bodyCode = bodyErrorCode(body);
  if (bodyCode) return bodyCode;
  if (status >= 500) return "server";
  return STATUS_ERROR_CODES[status] ?? "server";
}

/** @param {Record<string, unknown>} body */
function bodyErrorCode(body) {
  const candidate = typeof body.code === "string" ? body.code : body.error;
  return typeof candidate === "string" ? BODY_ERROR_CODES[candidate] : undefined;
}

/**
 * @param {string} reference
 */
function pathFor(reference) {
  return `/_internal/episode-diagnostics/${encodeURIComponent(reference)}`;
}

/**
 * @param {Record<string, unknown>} query
 */
function queryParams(query) {
  const params = {};
  const entries = queryEntries(query);
  // Keep one spelling per value. The API accepts snake-case; `around` is kept
  // for fixture servers and older local brokers.
  for (const [key, value] of entries) addQueryParam(params, key, value);
  deleteLegacyAliases(params, query);
  return params;
}

/** @param {Record<string, unknown>} query */
function queryEntries(query) {
  return [
    ["around", query.aroundSeconds],
    ["around_seconds", query.aroundSeconds],
    ["branch", query.branchId],
    ["branch_id", query.branchId],
    ["cursor", query.cursor ?? query.atCursor],
    ["after", query.afterCursor],
    ["before", query.beforeCursor],
    ["limit", query.limit],
    ["page_size", query.pageSize],
    ["latest", query.latest === true ? "true" : undefined],
  ];
}

/**
 * @param {Record<string, string>} params
 * @param {string} key
 * @param {unknown} value
 */
function addQueryParam(params, key, value) {
  if (value === undefined || value === null) return;
  if (params[key]) return;
  params[key] = String(value);
}

/**
 * @param {Record<string, string>} params
 * @param {Record<string, unknown>} query
 */
function deleteLegacyAliases(params, query) {
  if (query.aroundSeconds !== undefined) delete params.around;
  if (query.branchId !== undefined) delete params.branch;
}

export { pathFor as diagnosticEndpointPath };
