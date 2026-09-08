// @ts-check

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { resolveFeedbackOperatorConfig } from "./feedback-config.mjs";
import { parseFeedbackEvidenceBytes, parseFeedbackListResponse, parseFeedbackReport, parseFeedbackId, MAX_FEEDBACK_EVIDENCE_BYTES } from "./feedback-parsers.mjs";
import { DiagnosticInspectError } from "./errors.mjs";

const FEEDBACK_PATH = "/_internal/feedback-reports";
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 450 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * @typedef {{ config?: import("./feedback-config.mjs").FeedbackOperatorConfig; baseUrl?: string; environment?: string; credential?: string; credentialFile?: string; observabilityOrigin?: string; observabilityHosts?: string | string[]; fetchImpl?: typeof fetch; fetch?: typeof fetch; env?: NodeJS.ProcessEnv }} FeedbackClientOptions
 */

/**
 * @typedef {{ category?: import("./feedback-parsers.mjs").FeedbackCategory; source?: import("./feedback-parsers.mjs").FeedbackSource; tenant_id?: string; tenant?: string; from?: string; to?: string; cursor?: string; page_size?: number; limit?: number }} FeedbackListFilters
 */

/**
 * @typedef {{ category?: string; source?: string; tenant_id?: string; from?: string; to?: string; cursor?: string; page_size?: string }} FeedbackQuery
 */

/** @typedef {{ Accept: string; Authorization?: string }} FeedbackRequestHeaders */
/** @typedef {{ body: unknown; status: number; url: string }} FeedbackJSONResponse */
/** @typedef {import("./feedback-parsers.mjs").FeedbackEvidence} FeedbackEvidence */
/** @typedef {import("./feedback-parsers.mjs").FeedbackListResponse} FeedbackListResponse */
/** @typedef {import("./feedback-parsers.mjs").FeedbackReport} FeedbackReport */

/**
 * @typedef {{ bytes: Uint8Array; size: number; sha256: string; contentType: string; url: string }} FeedbackDownload
 */

/** @typedef {FeedbackDownload & { value: FeedbackEvidence }} FeedbackEvidenceDownload */

/**
 * @typedef {{ config: import("./feedback-config.mjs").FeedbackOperatorConfig; list: (filters?: FeedbackListFilters) => Promise<FeedbackListResponse>; show: (id: string) => Promise<FeedbackReport>; evidence: (id: string) => Promise<FeedbackEvidenceDownload>; screenshot: (id: string) => Promise<FeedbackDownload>; detail: (id: string) => Promise<FeedbackReport>; readEvidence: (id: string) => Promise<FeedbackEvidenceDownload>; readScreenshot: (id: string) => Promise<FeedbackDownload> }} FeedbackClient
 */

/**
 * @param {FeedbackClientOptions} [options]
 * @returns {Promise<FeedbackClient>}
 */
export async function createFeedbackClient(options = {}) {
  const config = await resolveFeedbackOperatorConfig(options);
  const fetchImpl = options.fetchImpl ?? options.fetch ?? config.fetchImpl;
  const baseUrl = config.baseUrl.replace(/\/$/u, "");
  const headers = { Accept: "application/json", ...(config.credential ? { Authorization: `Bearer ${config.credential}` } : {}) };
  const client = {
    config: { ...config, credential: undefined, fetchImpl: undefined },
    /** @param {FeedbackListFilters} [filters] */
    async list(filters = {}) {
      const query = listQuery(filters);
      const response = await requestJSON(fetchImpl, headers, `${baseUrl}${FEEDBACK_PATH}`, query, MAX_JSON_RESPONSE_BYTES);
      return parseFeedbackListResponse(response.body);
    },
    /** @param {string} id */
    async show(id) {
      const reportId = parseFeedbackId(id);
      const response = await requestJSON(fetchImpl, headers, `${baseUrl}${FEEDBACK_PATH}/${encodeURIComponent(reportId)}`, undefined, MAX_JSON_RESPONSE_BYTES);
      return parseFeedbackReport(response.body);
    },
    /** @param {string} id */
    async evidence(id) {
      return requestEvidence(fetchImpl, headers, baseUrl, id);
    },
    /** @param {string} id */
    async screenshot(id) {
      return requestScreenshot(fetchImpl, headers, baseUrl, id);
    },
    /** @param {string} id */
    async detail(id) {
      const reportId = parseFeedbackId(id);
      const response = await requestJSON(fetchImpl, headers, `${baseUrl}${FEEDBACK_PATH}/${encodeURIComponent(reportId)}`, undefined, MAX_JSON_RESPONSE_BYTES);
      return parseFeedbackReport(response.body);
    },
    /** @param {string} id */
    async readEvidence(id) {
      return requestEvidence(fetchImpl, headers, baseUrl, id);
    },
    /** @param {string} id */
    async readScreenshot(id) {
      return requestScreenshot(fetchImpl, headers, baseUrl, id);
    },
  };
  return client;
}

/** @param {typeof fetch} fetchImpl @param {FeedbackRequestHeaders} headers @param {string} baseUrl @param {string} id @returns {Promise<FeedbackEvidenceDownload>} */
async function requestEvidence(fetchImpl, headers, baseUrl, id) {
  const reportId = parseFeedbackId(id);
  const download = await requestDownload(fetchImpl, headers, `${baseUrl}${FEEDBACK_PATH}/${encodeURIComponent(reportId)}/evidence`, MAX_FEEDBACK_EVIDENCE_BYTES);
  const parsed = parseFeedbackEvidenceBytes(download.bytes);
  if (parsed.bytes.byteLength !== download.size || sha256(parsed.bytes) !== download.sha256) throw new DiagnosticInspectError("checksum_mismatch", "Feedback evidence checksum verification failed");
  return { ...download, value: parsed.value };
}

/** @param {typeof fetch} fetchImpl @param {FeedbackRequestHeaders} headers @param {string} baseUrl @param {string} id @returns {Promise<FeedbackDownload>} */
async function requestScreenshot(fetchImpl, headers, baseUrl, id) {
  const reportId = parseFeedbackId(id);
  return requestDownload(fetchImpl, headers, `${baseUrl}${FEEDBACK_PATH}/${encodeURIComponent(reportId)}/screenshot`, MAX_SCREENSHOT_BYTES);
}

/** @param {FeedbackListFilters} filters @returns {FeedbackQuery} */
function listQuery(filters) {
  validateListFilterKeys(filters);
  return {
    ...enumFilters(filters),
    ...tenantFilter(filters),
    ...timeFilters(filters),
    ...cursorFilter(filters),
    ...pageFilter(filters),
  };
}

/** @param {FeedbackListFilters} filters */
function validateListFilterKeys(filters) {
  const allowed = new Set(["category", "source", "tenant_id", "tenant", "from", "to", "cursor", "page_size", "limit"]);
  for (const key of Object.keys(filters)) {
    if (!allowed.has(key)) throw new DiagnosticInspectError("invalid_query", `Unknown feedback list filter ${key}`);
  }
}

/** @param {FeedbackListFilters} filters @returns {FeedbackQuery} */
function enumFilters(filters) {
  return {
    ...(filters.category === undefined ? {} : { category: enumFilter(filters.category, ["bug", "feature_request", "other"], "category") }),
    ...(filters.source === undefined ? {} : { source: enumFilter(filters.source, ["embedded", "chalk_web", "chalk_mobile", "dashboard"], "source") }),
  };
}

/** @param {FeedbackListFilters} filters @returns {FeedbackQuery} */
function tenantFilter(filters) {
  const tenant = filters.tenant_id ?? filters.tenant;
  return tenant === undefined ? {} : { tenant_id: parseFeedbackId(tenant) };
}

/** @param {FeedbackListFilters} filters @returns {FeedbackQuery} */
function timeFilters(filters) {
  const from = timeFilter(filters.from, "from");
  const to = timeFilter(filters.to, "to");
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

/** @param {string | undefined} value @param {string} key @returns {string | undefined} */
function timeFilter(value, key) {
  if (value === undefined) return undefined;
  const bounded = boundedQueryString(value, 64, key);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(bounded) || Number.isNaN(Date.parse(bounded))) throw new DiagnosticInspectError("invalid_query", `Feedback ${key} must be an RFC3339 timestamp`);
  return bounded;
}

/** @param {FeedbackListFilters} filters @returns {FeedbackQuery} */
function cursorFilter(filters) {
  return filters.cursor === undefined ? {} : { cursor: boundedQueryString(filters.cursor, 512, "cursor") };
}

/** @param {FeedbackListFilters} filters @returns {FeedbackQuery} */
function pageFilter(filters) {
  const pageSize = filters.page_size ?? filters.limit;
  if (pageSize === undefined) return {};
  validatePageSize(pageSize);
  return { page_size: String(pageSize) };
}

/** @param {number} pageSize */
function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new DiagnosticInspectError("invalid_query", "Feedback page size must be between 1 and 100");
}

/** @param {unknown} value @param {string[]} allowed @param {string} label */
function enumFilter(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) throw new DiagnosticInspectError("invalid_query", `Feedback ${label} is unsupported`);
  return value;
}

/** @param {unknown} value @param {number} max @param {string} label */
function boundedQueryString(value, max, label) {
  if (!isBoundedQueryString(value, max)) throw new DiagnosticInspectError("invalid_query", `Feedback ${label} is invalid`);
  return value;
}

/** @param {unknown} value @param {number} max */
function isBoundedQueryString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** @param {typeof fetch} fetchImpl @param {FeedbackRequestHeaders} headers @param {string} endpoint @param {FeedbackQuery | undefined} query @param {number} maxBytes @returns {Promise<FeedbackJSONResponse>} */
async function requestJSON(fetchImpl, headers, endpoint, query, maxBytes) {
  const url = requestURL(endpoint, query);
  const response = await fetchResponse(fetchImpl, headers, url);
  const bytes = await responseBytes(response, maxBytes);
  if (!response.ok) throw responseError(response.status, bytes);
  return { body: decodeJSON(bytes), status: response.status, url: url.toString() };
}

/** @param {string} endpoint @param {FeedbackQuery | undefined} query */
function requestURL(endpoint, query) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

/** @param {Uint8Array} bytes */
function decodeJSON(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new DiagnosticInspectError("invalid_contract", "Feedback service returned invalid JSON", { cause: error });
  }
}

/** @param {typeof fetch} fetchImpl @param {FeedbackRequestHeaders} headers @param {string} endpoint @param {number} maxBytes @returns {Promise<FeedbackDownload>} */
async function requestDownload(fetchImpl, headers, endpoint, maxBytes) {
  const url = new URL(endpoint);
  const response = await fetchResponse(fetchImpl, headers, url);
  const declaredSize = contentLength(response);
  validateDeclaredSize(declaredSize, maxBytes);
  const bytes = await responseBytes(response, maxBytes);
  if (!response.ok) throw responseError(response.status, bytes);
  const checksum = responseChecksum(response);
  validateDownloadSize(declaredSize, bytes);
  validateChecksum(bytes, checksum);
  return { bytes, size: bytes.byteLength, sha256: checksum, contentType: response.headers?.get?.("Content-Type") ?? "application/octet-stream", url: url.toString() };
}

/** @param {number | undefined} declaredSize @param {number} maxBytes */
function validateDeclaredSize(declaredSize, maxBytes) {
  if (declaredSize !== undefined && (declaredSize < 0 || declaredSize > maxBytes)) throw new DiagnosticInspectError("size_limit", "Feedback download exceeds its size limit");
}

/** @param {Response} response */
function responseChecksum(response) {
  const checksum = response.headers?.get?.("Content-SHA256")?.trim() ?? "";
  if (!SHA256_PATTERN.test(checksum)) throw new DiagnosticInspectError("invalid_contract", "Feedback download did not include a valid checksum");
  return checksum;
}

/** @param {number | undefined} declaredSize @param {Uint8Array} bytes */
function validateDownloadSize(declaredSize, bytes) {
  if (declaredSize !== undefined && declaredSize !== bytes.byteLength) throw new DiagnosticInspectError("invalid_contract", "Feedback download size did not match its header");
}

/** @param {Uint8Array} bytes @param {string} checksum */
function validateChecksum(bytes, checksum) {
  if (sha256(bytes) !== checksum) throw new DiagnosticInspectError("checksum_mismatch", "Feedback download checksum verification failed");
}

/** @param {Response} response */
function contentLength(response) {
  const value = contentLengthValue(response);
  if (value === undefined) return undefined;
  if (value === "") return undefined;
  return parseContentLength(value);
}

/** @param {Response} response */
function contentLengthValue(response) {
  return response.headers?.get?.("Content-Length") ?? undefined;
}

/** @param {string} value */
function parseContentLength(value) {
  if (!/^\d+$/u.test(value)) throw new DiagnosticInspectError("invalid_contract", "Feedback download size header is invalid");
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new DiagnosticInspectError("size_limit", "Feedback download size is out of bounds");
  return size;
}

/** @param {Response} response @param {number} maxBytes */
async function responseBytes(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (reader) return readBoundedBody(reader, maxBytes);
  return readArrayBuffer(response, maxBytes);
}

/** @param {Response} response @param {number} maxBytes */
async function readArrayBuffer(response, maxBytes) {
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new DiagnosticInspectError("transport", "Feedback service could not be read", { cause: error });
  }
  if (bytes.byteLength > maxBytes) throw new DiagnosticInspectError("size_limit", "Feedback response exceeds its size limit");
  return bytes;
}

/** @param {{ read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<void> }} reader @param {number} maxBytes @returns {Promise<Uint8Array>} */
async function readBoundedBody(reader, maxBytes) {
  try {
    const chunks = await readBodyChunks(reader, maxBytes);
    return joinBodyChunks(chunks);
  } catch (error) {
    if (error instanceof DiagnosticInspectError) throw error;
    throw new DiagnosticInspectError("transport", "Feedback service could not be read", { cause: error });
  }
}

/** @param {{ read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<void> }} reader @param {number} maxBytes @returns {Promise<Uint8Array[]>} */
async function readBodyChunks(reader, maxBytes) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return chunks;
    const value = bodyChunkValue(chunk);
    total += value.byteLength;
    await ensureBodyLimit(reader, total, maxBytes);
    chunks.push(value);
  }
}

/** @param {{ value?: Uint8Array }} chunk */
function bodyChunkValue(chunk) {
  return chunk.value ?? new Uint8Array();
}

/** @param {{ cancel?: () => Promise<void> }} reader @param {number} total @param {number} maxBytes */
async function ensureBodyLimit(reader, total, maxBytes) {
  if (total <= maxBytes) return;
  await reader.cancel?.();
  throw new DiagnosticInspectError("size_limit", "Feedback response exceeds its size limit");
}

/** @param {Uint8Array[]} chunks */
function joinBodyChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** @param {typeof fetch} fetchImpl @param {FeedbackRequestHeaders} headers @param {URL} url @returns {Promise<Response>} */
async function fetchResponse(fetchImpl, headers, url) {
  try {
    return await fetchImpl(url, { method: "GET", headers });
  } catch (error) {
    throw new DiagnosticInspectError("transport", "Feedback service could not be reached", { cause: error });
  }
}

/** @param {number} status @param {Uint8Array} bytes */
function responseError(status, bytes) {
  const code = responseCode(status, bytes);
  const messages = {
    unauthorized: "Feedback operator authorization was denied",
    forbidden: "Feedback operator is not allowed to read this report",
    not_found: "Feedback report was not found",
    rate_limited: "Feedback service rate limit was reached",
    server: "Feedback service returned an unavailable response",
  };
  return new DiagnosticInspectError(code, messages[code] ?? "Feedback service rejected the request");
}

/** @param {number} status @param {Uint8Array} bytes */
function responseCode(status, bytes) {
  return responseStatus(status, responseCandidate(bytes));
}

/** @param {Uint8Array} bytes @returns {string | undefined} */
function responseCandidate(bytes) {
  return responseErrorCode(decodeResponseBody(bytes));
}

/** @param {Uint8Array} bytes */
function decodeResponseBody(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** @param {unknown} body */
function responseErrorCode(body) {
  if (!isObjectWithError(body)) return undefined;
  const error = body.error;
  if (!isObject(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** @param {unknown} value */
function isObjectWithError(value) {
  return isObject(value) && "error" in value;
}

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === "object";
}

/** @param {number} status @param {string | undefined} candidate */
function responseStatus(status, candidate) {
  const statusCodes = new Map([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
  ]);
  const candidates = new Map([
    ["request.unauthenticated", "unauthorized"],
    ["request.forbidden", "forbidden"],
    ["feedback.not_found", "not_found"],
    ["request.rate_limited", "rate_limited"],
  ]);
  return statusCodes.get(status) ?? candidates.get(candidate) ?? "server";
}

/** @param {Uint8Array} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export { FEEDBACK_PATH, MAX_JSON_RESPONSE_BYTES, MAX_SCREENSHOT_BYTES };
