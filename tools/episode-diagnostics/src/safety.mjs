// @ts-check

const FORBIDDEN_KEY = /(?:token|secret|password|credential|cookie|authorization|payload|content|body|text|display.?name|filename|url|uri|email|phone|exception|stack|sdp|ice|candidate|address|webhook)/iu;
const FORBIDDEN_VALUE = /(?:https?:\/\/|wss?:\/\/|bearer\s+[a-z0-9._~+\/-]+|(?:password|token|credential|secret)\s*[:=]\s*\S+|-----begin|candidate:|v=0\r?\n|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/iu;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u;
const MAX_DEPTH = 10;
const MAX_ARRAY = 1_000;
const MAX_KEYS = 128;
const MAX_STRING = 512;

/**
 * Sanitize server data before it reaches either a human renderer or an agent.
 * Unknown fields are retained only when their key and value are safe; unsafe
 * values become an explicit omission so absence cannot be mistaken for proof.
 *
 * @param {unknown} value
 * @param {{ depth?: number }} [options]
 * @returns {unknown}
 */
export function sanitizeDiagnosticData(value, options = {}) {
  return sanitize(value, options.depth ?? 0);
}

/**
 * @param {unknown} value
 * @param {number} depth
 */
function sanitize(value, depth) {
  if (depth > MAX_DEPTH) return { unknownReason: "not_available" };
  return sanitizeValue(value, depth);
}

/** @param {unknown} value @param {number} depth */
function sanitizeValue(value, depth) {
  if (value === null) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return sanitizeArray(value, depth);
  return sanitizeNonComposite(value, depth);
}

/** @param {unknown} value @param {number} depth */
function sanitizeNonComposite(value, depth) {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") return { unknownReason: "not_available" };
  return sanitizeObject(value, depth);
}

/** @param {string} value */
function sanitizeString(value) {
  return FORBIDDEN_VALUE.test(value) ? "[redacted]" : value.slice(0, MAX_STRING);
}

/** @param {unknown[]} value @param {number} depth */
function sanitizeArray(value, depth) {
  return value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1));
}

/** @param {object} value @param {number} depth */
function sanitizeObject(value, depth) {
  const output = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_KEYS) break;
    const sanitized = sanitizeObjectEntry(key, item, depth);
    if (sanitized === undefined) continue;
    output[key] = sanitized;
    count += 1;
  }
  return output;
}

/** @param {string} key @param {unknown} value @param {number} depth */
function sanitizeObjectEntry(key, value, depth) {
  if (!SAFE_KEY.test(key)) return undefined;
  if (FORBIDDEN_KEY.test(key)) return { unknownReason: "redacted" };
  return sanitize(value, depth + 1);
}

/**
 * @param {unknown} value
 */
function containsUnsafeDiagnosticData(value) {
  if (typeof value === "string") return FORBIDDEN_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsUnsafeDiagnosticData);
  if (!isObject(value)) return false;
  return Object.entries(value).some(unsafeEntry);
}

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === "object";
}

/** @param {[string, unknown]} entry */
function unsafeEntry([key, value]) {
  if (FORBIDDEN_KEY.test(key)) return true;
  return containsUnsafeDiagnosticData(value);
}
