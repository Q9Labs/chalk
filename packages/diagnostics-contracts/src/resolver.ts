import { parseDiagnosticIssue, parseDiagnosticOperation } from "./details.js";
import { parseAcceptedDiagnosticEvent } from "./events.js";
import { parseDiagnosticReference } from "./references.js";
import { validateDiagnosticSnapshot } from "./snapshot.js";
import { UNKNOWN_REASONS } from "./allowlists.js";
import { checkEnum, checkSafeToken, finishValidation, isRecord, isString, parseOrThrow, requireString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import type { DiagnosticResolverResponseV1, DiagnosticSnapshotV1 } from "./types.js";

const validateOptionalReference = (input: Record<string, unknown>, issues: ValidationIssue[]): string | undefined => {
  if (input.reference === undefined) return undefined;
  if (!isString(input.reference)) {
    issues.push({ path: "$.reference", message: "reference must be a string" });
    return undefined;
  }
  try {
    parseDiagnosticReference(input.reference);
  } catch {
    issues.push({ path: "$.reference", message: "reference is malformed" });
  }
  return input.reference;
};

export const validateDiagnosticResolverResponse = (input: unknown): ValidationResult<DiagnosticResolverResponseV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected resolver response" }] };
  const kind = input.kind;
  if (!checkEnum(kind, ["diagnostic", "operation", "issue", "event", "not_found"] as const, "$.kind", issues)) return { ok: false, issues };
  const referenceValue = validateOptionalReference(input, issues);
  if (kind === "not_found") return validateNotFoundResponse(input, kind, referenceValue, issues);
  const snapshotResult = validateDiagnosticSnapshot(input.snapshot);
  if (!snapshotResult.ok) issues.push(...snapshotResult.issues);
  const reference = requireString(input, "reference", issues);
  if (!snapshotResult.ok || !reference) return { ok: false, issues };
  return validateResolverEntity(kind, input, reference, snapshotResult.value, issues);
};

export const parseDiagnosticResolverResponse = (input: unknown): DiagnosticResolverResponseV1 => parseOrThrow(validateDiagnosticResolverResponse(input), "Invalid resolver response");

const validateNotFoundResponse = (input: Record<string, unknown>, kind: "not_found", reference: string | undefined, issues: ValidationIssue[]): ValidationResult<DiagnosticResolverResponseV1> => {
  const reason = requireString(input, "reason", issues);
  if (reason !== undefined && !UNKNOWN_REASONS.includes(reason as (typeof UNKNOWN_REASONS)[number])) checkSafeToken(reason, "$.reason", issues, 96);
  if (!reason) return { ok: false, issues };
  return finishValidation({ kind, ...(reference === undefined ? {} : { reference }), reason }, issues);
};

type ResolverEntityKind = Exclude<DiagnosticResolverResponseV1["kind"], "not_found">;

const validateResolverEntity = (kind: ResolverEntityKind, input: Record<string, unknown>, reference: string, snapshot: DiagnosticSnapshotV1, issues: ValidationIssue[]): ValidationResult<DiagnosticResolverResponseV1> => {
  if (kind === "diagnostic") return finishValidation({ kind, reference, snapshot }, issues);
  try {
    if (kind === "operation") return finishValidation({ kind, reference, snapshot, operation: parseDiagnosticOperation(input.operation) }, issues);
    if (kind === "issue") return finishValidation({ kind, reference, snapshot, issue: parseDiagnosticIssue(input.issue) }, issues);
    return finishValidation({ kind, reference, snapshot, event: parseAcceptedDiagnosticEvent(input.event) }, issues);
  } catch {
    const detail = kind === "operation" ? "operation" : kind === "issue" ? "issue" : "event";
    issues.push({ path: `$.${detail}`, message: detail === "event" ? "invalid accepted Event" : `invalid ${detail}` });
    return { ok: false, issues };
  }
};
