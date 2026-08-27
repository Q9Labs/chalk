// @ts-check

import { DiagnosticInspectError } from "./errors.mjs";

const ENVIRONMENTS = new Set(["localhost", "development", "staging", "production"]);
const REFERENCE_PATTERN = /^chalkdiag:v1:([a-z]+):([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?::(op|issue|event):([A-Za-z0-9][A-Za-z0-9_-]{0,127}))?(?:@([0-9]+))?$/u;

/**
 * @typedef {{ version: 1; environment: "localhost"|"development"|"staging"|"production"; diagnosticId: string; focus?: { kind: "op"|"issue"|"event"; id: string }; cursor?: number }} DiagnosticReference
 */

/**
 * Parse only the canonical v1 reference. A resolver must never guess an
 * environment or reinterpret a focus from a malformed string.
 *
 * @param {unknown} value
 * @returns {DiagnosticReference}
 */
export function parseReference(value) {
  if (typeof value !== "string") throw new DiagnosticInspectError("malformed", "Diagnostic reference must be a string");
  const match = referenceMatch(value);
  const cursor = parseCursor(match[5]);
  return referenceFromMatch(match, cursor);
}

/** @param {string} value */
function referenceMatch(value) {
  const match = REFERENCE_PATTERN.exec(value);
  if (!match) throw new DiagnosticInspectError("malformed", "Malformed diagnostic reference");
  if (!ENVIRONMENTS.has(match[1])) throw new DiagnosticInspectError("malformed", "Malformed diagnostic reference");
  return match;
}

/** @param {string | undefined} cursorText */
function parseCursor(cursorText) {
  if (cursorText === undefined) return undefined;
  if (cursorOutOfBounds(cursorText)) throw new DiagnosticInspectError("malformed", "Diagnostic reference cursor is out of bounds");
  return Number(cursorText);
}

/** @param {string} cursorText */
function cursorOutOfBounds(cursorText) {
  if (cursorText.length > 1 && cursorText.startsWith("0")) return true;
  return Number(cursorText) > Number.MAX_SAFE_INTEGER;
}

/** @param {RegExpExecArray} match @param {number | undefined} cursor */
function referenceFromMatch(match, cursor) {
  const reference = /** @type {DiagnosticReference & Record<string, any>} */ ({
    version: 1,
    environment: /** @type {DiagnosticReference["environment"]} */ (match[1]),
    diagnosticId: match[2],
  });
  if (match[3] && match[4]) reference.focus = { kind: /** @type {"op"|"issue"|"event"} */ (match[3]), id: match[4] };
  if (cursor !== undefined) reference.cursor = cursor;
  return reference;
}

/**
 * @param {DiagnosticReference} reference
 */
export function formatReference(reference) {
  let value = `chalkdiag:v1:${reference.environment}:${reference.diagnosticId}`;
  if (reference.focus) value += `:${reference.focus.kind}:${reference.focus.id}`;
  if (reference.cursor !== undefined) value += `@${reference.cursor}`;
  return value;
}

export const enabledEnvironments = Object.freeze([...ENVIRONMENTS]);
