import { MAX_PAGE_SIZE } from "./allowlists.js";
import { tryParseDiagnosticReference } from "./references.js";
import type { ValidationIssue, ValidationResult } from "./runtime.js";

export type DetailInput = Record<string, unknown>;
export type DetailValidator<T> = (input: unknown, path?: string) => ValidationResult<T>;

export const checkBoundedArray = (value: unknown, path: string, issues: ValidationIssue[], message: string): value is unknown[] => {
  const array = Array.isArray(value);
  if (!array || value.length > MAX_PAGE_SIZE) issues.push({ path, message });
  return array;
};

export const parseDetailArray = <T>(values: unknown[], path: string, issues: ValidationIssue[], validate: DetailValidator<T>): T[] => {
  const parsed: T[] = [];
  for (const [index, value] of values.entries()) {
    const result = validate(value, `${path}[${index}]`);
    if (result.ok) parsed.push(result.value);
    else issues.push(...result.issues);
  }
  return parsed;
};

export const assignPresentFields = (target: DetailInput, input: DetailInput, keys: readonly string[]): void => {
  for (const key of keys) {
    if (input[key] !== undefined) target[key] = input[key];
  }
};

export const validateReference = (value: unknown, path: string, issues: ValidationIssue[]): string | undefined => {
  const result = tryParseDiagnosticReference(value);
  if (!result.ok) {
    issues.push({ path, message: "expected a canonical Diagnostic Reference" });
    return undefined;
  }
  return value as string;
};
