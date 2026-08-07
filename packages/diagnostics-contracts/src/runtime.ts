import type { SafeUnknownReason } from "./types.js";

export type ValidationIssue = Readonly<{
  path: string;
  message: string;
}>;

export type ValidationResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; issues: readonly ValidationIssue[] }>;

export class DiagnosticContractError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[] = [{ path: "$", message }]) {
    super(message);
    this.name = "DiagnosticContractError";
    this.issues = issues;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string => typeof value === "string";
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const isInteger = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value);
export const isNonNegativeInteger = (value: unknown): value is number => isInteger(value) && value >= 0;

export const ownKeys = (value: Record<string, unknown>): string[] => Object.keys(value);

export const pushUnknownKeys = (value: Record<string, unknown>, allowed: readonly string[], issues: ValidationIssue[], path: string): void => {
  const allowedSet = new Set(allowed);
  for (const key of ownKeys(value)) {
    if (!allowedSet.has(key)) issues.push({ path: `${path}.${key}`, message: "unknown property" });
  }
};

export const requireString = (value: Record<string, unknown>, key: string, issues: ValidationIssue[], path = "$"): string | undefined => {
  const candidate = value[key];
  if (!isString(candidate) || candidate.length === 0) {
    issues.push({ path: `${path}.${key}`, message: "expected a non-empty string" });
    return undefined;
  }
  return candidate;
};

export const optionalString = (value: Record<string, unknown>, key: string, issues: ValidationIssue[], path = "$"): string | undefined => {
  if (value[key] === undefined) return undefined;
  return requireString(value, key, issues, path);
};

export const requireFiniteNumber = (value: Record<string, unknown>, key: string, issues: ValidationIssue[], path = "$"): number | undefined => {
  const candidate = value[key];
  if (!isFiniteNumber(candidate)) {
    issues.push({ path: `${path}.${key}`, message: "expected a finite number" });
    return undefined;
  }
  return candidate;
};

export const requireInteger = (value: Record<string, unknown>, key: string, issues: ValidationIssue[], path = "$"): number | undefined => {
  const candidate = value[key];
  if (!isInteger(candidate)) {
    issues.push({ path: `${path}.${key}`, message: "expected an integer" });
    return undefined;
  }
  return candidate;
};

export const optionalInteger = (value: Record<string, unknown>, key: string, issues: ValidationIssue[], path = "$"): number | undefined => {
  if (value[key] === undefined) return undefined;
  return requireInteger(value, key, issues, path);
};

export const checkEnum = <T extends string>(value: unknown, allowed: readonly T[], path: string, issues: ValidationIssue[]): value is T => {
  if (typeof value === "string" && allowed.includes(value as T)) return true;
  issues.push({ path, message: `expected one of: ${allowed.join(", ")}` });
  return false;
};

export const checkDateTime = (value: unknown, path: string, issues: ValidationIssue[]): value is string => {
  if (typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))) return true;
  issues.push({ path, message: "expected an ISO date-time" });
  return false;
};

export const checkSafeToken = (value: unknown, path: string, issues: ValidationIssue[], maxLength = 128): value is string => {
  if (typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9._:@+/=-]*$/.test(value)) return true;
  issues.push({ path, message: "expected a bounded safe token" });
  return false;
};

export const checkUnknownReason = (value: unknown, path: string, issues: ValidationIssue[]): value is SafeUnknownReason => {
  const allowed: readonly SafeUnknownReason[] = ["not_retained", "not_observable", "redacted", "provider_opaque", "expired", "not_available", "invalid", "diagnostics_disabled", "permission_denied", "unknown"];
  return checkEnum(value, allowed, path, issues);
};

export const finishValidation = <T>(value: T, issues: ValidationIssue[]): ValidationResult<T> => (issues.length === 0 ? { ok: true, value } : { ok: false, issues });

export const parseOrThrow = <T>(result: ValidationResult<T>, message = "Diagnostic contract validation failed"): T => {
  if (result.ok) return result.value;
  throw new DiagnosticContractError(message, result.issues);
};

export const assertNever = (value: never): never => {
  throw new DiagnosticContractError(`Unexpected diagnostic contract value: ${String(value)}`);
};
