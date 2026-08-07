import { validateDiagnosticSnapshot } from "./snapshot.js";
import { validateAcceptedDiagnosticEvent } from "./events.js";
import { validateDiagnosticBranch, validateDiagnosticIssue, validateDiagnosticOperation } from "./details.js";
import { checkEnum, checkSafeToken, finishValidation, isNonNegativeInteger, isRecord, isString, parseOrThrow, pushUnknownKeys, requireString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import { assignPresentFields, validateReference, type DetailInput } from "./validation-helpers.js";
import type { DiagnosticStreamDeltaV1 } from "./types.js";

type DeltaPayloadKey = "event" | "operation" | "issue" | "branch" | "snapshot" | "gap";
type DeltaPayloadDescriptor = Readonly<{
  key: DeltaPayloadKey;
  missingMessage: string;
  validate: (payload: DetailInput, issues: ValidationIssue[]) => void;
}>;

const validateDeltaEvent = (payload: DetailInput, issues: ValidationIssue[]): void => {
  const result = validateAcceptedDiagnosticEvent(payload);
  if (!result.ok) issues.push(...result.issues.map((issue) => ({ ...issue, path: `$.event${issue.path === "$" ? "" : issue.path.slice(1)}` })));
};

const appendDetailIssues = <T>(result: ValidationResult<T>, issues: ValidationIssue[]): void => {
  if (!result.ok) issues.push(...result.issues);
};

const validateDeltaGap = (payload: DetailInput, issues: ValidationIssue[]): void => {
  if (!isNonNegativeInteger(payload.fromCursor) || !isNonNegativeInteger(payload.toCursor) || !isString(payload.reason)) issues.push({ path: "$.gap", message: "gap requires bounded cursors and reason" });
};

const DELTA_PAYLOADS: Record<DiagnosticStreamDeltaV1["kind"], DeltaPayloadDescriptor> = {
  event_appended: { key: "event", missingMessage: "event_appended requires an Event", validate: validateDeltaEvent },
  operation_updated: { key: "operation", missingMessage: "operation_updated requires an operation", validate: (payload, issues) => appendDetailIssues(validateDiagnosticOperation(payload, "$.operation"), issues) },
  issue_updated: { key: "issue", missingMessage: "issue_updated requires an issue", validate: (payload, issues) => appendDetailIssues(validateDiagnosticIssue(payload, "$.issue"), issues) },
  branch_updated: { key: "branch", missingMessage: "branch_updated requires a branch", validate: (payload, issues) => appendDetailIssues(validateDiagnosticBranch(payload, "$.branch"), issues) },
  snapshot: { key: "snapshot", missingMessage: "snapshot delta requires a snapshot", validate: (payload, issues) => appendDetailIssues(validateDiagnosticSnapshot(payload), issues) },
  gap: { key: "gap", missingMessage: "gap delta requires a gap", validate: validateDeltaGap },
};

const validateDeltaPayload = (kind: DiagnosticStreamDeltaV1["kind"], input: DetailInput, issues: ValidationIssue[]): void => {
  const descriptor = DELTA_PAYLOADS[kind];
  const payload = input[descriptor.key];
  if (!isRecord(payload)) {
    issues.push({ path: `$.${descriptor.key}`, message: descriptor.missingMessage });
    return;
  }
  descriptor.validate(payload, issues);
};

const buildDiagnosticStreamDelta = (input: DetailInput, reference: string, cursor: number, kind: DiagnosticStreamDeltaV1["kind"], filterFingerprint: string): DiagnosticStreamDeltaV1 => {
  const delta: DetailInput = {
    schemaVersion: "DiagnosticStreamDelta/v1",
    reference,
    cursor,
    kind,
    filterFingerprint,
  };
  assignPresentFields(delta, input, ["event", "operation", "issue", "branch", "snapshot", "gap"]);
  return delta as unknown as DiagnosticStreamDeltaV1;
};

export const validateDiagnosticStreamDelta = (input: unknown): ValidationResult<DiagnosticStreamDeltaV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected stream delta object" }] };
  const keys = ["schemaVersion", "reference", "cursor", "kind", "filterFingerprint", "event", "operation", "issue", "branch", "snapshot", "gap"] as const;
  pushUnknownKeys(input, keys, issues, "$");
  if (input.schemaVersion !== "DiagnosticStreamDelta/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticStreamDelta/v1" });
  const reference = validateReference(input.reference, "$.reference", issues);
  if (!isNonNegativeInteger(input.cursor)) issues.push({ path: "$.cursor", message: "cursor must be non-negative" });
  const kind = input.kind;
  if (!checkEnum(kind, ["event_appended", "operation_updated", "issue_updated", "branch_updated", "snapshot", "gap"] as const, "$.kind", issues)) return { ok: false, issues };
  const filterFingerprint = requireString(input, "filterFingerprint", issues);
  if (filterFingerprint !== undefined) checkSafeToken(filterFingerprint, "$.filterFingerprint", issues, 128);
  validateDeltaPayload(kind, input, issues);
  if (!reference || !isNonNegativeInteger(input.cursor) || !filterFingerprint) return { ok: false, issues };
  return finishValidation(buildDiagnosticStreamDelta(input, reference, input.cursor, kind, filterFingerprint), issues);
};

export const parseDiagnosticStreamDelta = (input: unknown): DiagnosticStreamDeltaV1 => parseOrThrow(validateDiagnosticStreamDelta(input), "Invalid diagnostic stream delta");
export const validateSseDelta = validateDiagnosticStreamDelta;
export const parseSseDelta = parseDiagnosticStreamDelta;
