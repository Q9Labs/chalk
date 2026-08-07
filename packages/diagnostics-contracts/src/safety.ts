import { ATTRIBUTE_KEYS, MAX_ATTRIBUTE_COUNT, MAX_ATTRIBUTE_STRING_LENGTH, isAllowedAttributeKey } from "./allowlists.js";
import { DiagnosticContractError, finishValidation, isBoolean, isFiniteNumber, isRecord, isString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import type { DiagnosticAttributes, SafeUnknownReason } from "./types.js";

const FORBIDDEN_KEY = /(?:text|content|body|payload|display.?name|filename|url|uri|token|secret|password|credential|cookie|authorization|exception|stack|sdp|ice|candidate|address|phone|email|webhook)/i;
const FORBIDDEN_VALUE =
  /(?:https?:\/\/|wss?:\/\/|ftp:\/\/|www\.|bearer\s+[a-z0-9._~+\/-]+|(?:password|passwd|secret|token|credential|authorization|api[_-]?key|client[_-]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)|-----begin|candidate:|v=0\r?\n|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i;
const SAFE_TEXT = /^[\x20-\x7e]+$/;

export type RedactionResult = Readonly<{
  attributes: DiagnosticAttributes;
  redactedKeys: readonly string[];
  rejectedKeys: readonly string[];
}>;

export type Rejection = Readonly<{
  path: string;
  reason: "forbidden_key" | "forbidden_value" | "unknown_key" | "invalid_type" | "oversize";
}>;

export const isForbiddenDiagnosticKey = (key: string): boolean => FORBIDDEN_KEY.test(key);
export const isForbiddenDiagnosticValue = (value: string): boolean => FORBIDDEN_VALUE.test(value);

type SafeAttributeValue = boolean | number | string;
type AttributeClassification = Readonly<{ kind: "safe"; value: SafeAttributeValue }> | Readonly<{ kind: "redacted" }> | Readonly<{ kind: "rejected" }>;

const isSafeAttributeValue = (value: unknown): value is SafeAttributeValue => {
  if (isBoolean(value)) return true;
  if (isFiniteNumber(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return true;
  return isString(value) && value.length <= MAX_ATTRIBUTE_STRING_LENGTH && SAFE_TEXT.test(value) && !isForbiddenDiagnosticValue(value);
};

const classifyAttribute = (key: string, value: unknown): AttributeClassification => {
  if (isForbiddenDiagnosticKey(key) || !isAllowedAttributeKey(key)) return { kind: "redacted" };
  if (isSafeAttributeValue(value)) return { kind: "safe", value };
  return { kind: "rejected" };
};

const boundedRedaction = (attributes: Record<string, SafeAttributeValue>, rejectedKeys: string[]): DiagnosticAttributes => {
  const keys = Object.keys(attributes);
  const boundedKeys = keys.slice(0, MAX_ATTRIBUTE_COUNT);
  for (const key of keys.slice(MAX_ATTRIBUTE_COUNT)) rejectedKeys.push(key);
  const bounded: Record<string, SafeAttributeValue> = {};
  for (const key of boundedKeys) bounded[key] = attributes[key] as SafeAttributeValue;
  return bounded;
};

export const validateDiagnosticAttributes = (input: unknown, path = "$.attributes"): ValidationResult<DiagnosticAttributes> => {
  const issues: ValidationIssue[] = [];
  if (input === undefined) return { ok: true, value: {} };
  if (!isRecord(input)) return { ok: false, issues: [{ path, message: "expected an object" }] };
  const keys = Object.keys(input);
  if (keys.length > MAX_ATTRIBUTE_COUNT) issues.push({ path, message: `at most ${MAX_ATTRIBUTE_COUNT} attributes are allowed` });
  const output: Record<string, SafeAttributeValue> = {};
  for (const key of keys) {
    const classification = classifyAttribute(key, input[key]);
    if (classification.kind === "redacted") {
      issues.push({ path: `${path}.${key}`, message: "attribute key is not allowlisted" });
      continue;
    }
    if (classification.kind === "safe") {
      output[key] = classification.value;
      continue;
    }
    issues.push({ path: `${path}.${key}`, message: "attribute value is not safe or is too large" });
  }
  return finishValidation(output, issues);
};

export const assertSafeAttributes = (input: unknown): DiagnosticAttributes => {
  const result = validateDiagnosticAttributes(input);
  if (!result.ok) throw new DiagnosticContractError("Diagnostic attributes contain unsafe data", result.issues);
  return result.value;
};

export const redactDiagnosticAttributes = (input: unknown): RedactionResult => {
  if (!isRecord(input)) return { attributes: {}, redactedKeys: [], rejectedKeys: ["$"] };
  const attributes: Record<string, SafeAttributeValue> = {};
  const redactedKeys: string[] = [];
  const rejectedKeys: string[] = [];
  for (const key of Object.keys(input)) {
    const classification = classifyAttribute(key, input[key]);
    if (classification.kind === "redacted") {
      redactedKeys.push(key);
      continue;
    }
    if (classification.kind === "safe") {
      attributes[key] = classification.value;
      continue;
    }
    rejectedKeys.push(key);
  }
  return { attributes: boundedRedaction(attributes, rejectedKeys), redactedKeys, rejectedKeys };
};

export const redactAttributes = redactDiagnosticAttributes;

export const rejectUnsafeDiagnosticValue = (value: unknown, path = "$"): void => {
  if (isString(value) && !isForbiddenDiagnosticValue(value)) return;
  throw new DiagnosticContractError("Diagnostic value is forbidden", [{ path, message: "content, credentials, payloads, or network identifiers are not retained" }]);
};

export const safeUnknown = (reason: SafeUnknownReason): Readonly<{ value: undefined; unknownReason: SafeUnknownReason }> => ({ value: undefined, unknownReason: reason });

export const ALLOWLISTED_ATTRIBUTE_KEYS = ATTRIBUTE_KEYS;
