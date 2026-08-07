import { ENVIRONMENTS, MAX_PAGE_SIZE } from "./allowlists.js";
import { validateDiagnosticBranch, validateDiagnosticIssue, validateDiagnosticOperation } from "./details.js";
import { validateEpilogueProjection, validateFlameProjection, validateGraphProjection, validateParticipantProjection, validateRunProjection } from "./projections.js";
import { checkDateTime, checkEnum, checkSafeToken, finishValidation, isNonNegativeInteger, isRecord, isString, parseOrThrow, pushUnknownKeys, requireString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import { assignPresentFields, checkBoundedArray, parseDetailArray, validateReference, type DetailInput, type DetailValidator } from "./validation-helpers.js";
import type { DiagnosticBranchDetail, DiagnosticIssueDetail, DiagnosticOperationDetail, DiagnosticSnapshotV1, EpilogueProjectionV1, FlameProjectionV1, GraphProjectionV1, ParticipantProjectionV1, RunProjectionV1 } from "./types.js";

type SnapshotProjectionKey = "participants" | "run" | "graph" | "flame" | "epilogue";
type SnapshotProjection = ParticipantProjectionV1[] | RunProjectionV1 | GraphProjectionV1 | FlameProjectionV1 | EpilogueProjectionV1;

const SNAPSHOT_KEYS = ["schemaVersion", "reference", "environment", "state", "capturedAt", "committedCursor", "projectedCursor", "filterFingerprint", "runEndCursor", "summary", "operations", "issues", "branches", "participants", "run", "graph", "flame", "epilogue", "omissions"] as const;
const SNAPSHOT_STATES = ["live", "ended", "complete", "expired"] as const;
const SNAPSHOT_PROJECTIONS = [
  ["participants", "ParticipantProjection/v1"],
  ["run", "RunProjection/v1"],
  ["graph", "GraphProjection/v1"],
  ["flame", "FlameProjection/v1"],
  ["epilogue", "EpilogueProjection/v1"],
] as const satisfies readonly [SnapshotProjectionKey, string][];

const checkOptionalNonNegativeIntegers = (input: DetailInput, keys: readonly string[], path: string, issues: ValidationIssue[], message: (key: string) => string): void => {
  for (const key of keys) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) issues.push({ path: `${path}.${key}`, message: message(key) });
  }
};

const checkOptionalBoundedStringArray = (input: DetailInput, key: string, issues: ValidationIssue[]): void => {
  const value = input[key];
  if (value !== undefined && (!Array.isArray(value) || value.length > MAX_PAGE_SIZE || value.some((item) => !isString(item) || item.length > 160))) {
    issues.push({ path: `$.${key}`, message: "omissions must be bounded strings" });
  }
};

const validateSummary = (input: unknown, path: string, issues: ValidationIssue[]): DiagnosticSnapshotV1["summary"] | undefined => {
  if (!isRecord(input)) {
    issues.push({ path, message: "expected summary object" });
    return undefined;
  }
  const fields = ["eventCount", "operationCount", "issueCount", "openIssueCount", "participantCount"] as const;
  checkOptionalNonNegativeIntegers(input, fields, path, issues, (field) => `${field} must be a non-negative integer`);
  if (!fields.slice(0, 4).every((field) => isNonNegativeInteger(input[field]))) return undefined;
  return {
    eventCount: input.eventCount as number,
    operationCount: input.operationCount as number,
    issueCount: input.issueCount as number,
    openIssueCount: input.openIssueCount as number,
    ...(input.participantCount === undefined ? {} : { participantCount: input.participantCount as number }),
  };
};

const remapProjectionIssues = (issues: readonly ValidationIssue[], path: string): ValidationIssue[] => issues.map((issue) => ({ ...issue, path: `${path}${issue.path === "$" ? "" : issue.path.slice(1)}` }));

const validateParticipantProjections = (value: unknown, path: string, issues: ValidationIssue[]): ParticipantProjectionV1[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_PAGE_SIZE) {
    issues.push({ path, message: "participants must be bounded ParticipantProjection/v1 rows" });
    return undefined;
  }
  const parsed: ParticipantProjectionV1[] = [];
  for (const [index, participant] of value.entries()) {
    const result = validateParticipantProjection(participant);
    if (result.ok) parsed.push(result.value);
    else issues.push(...remapProjectionIssues(result.issues, `${path}[${index}]`));
  }
  return parsed.length === value.length ? parsed : undefined;
};

const SNAPSHOT_PROJECTION_VALIDATORS = {
  run: validateRunProjection,
  graph: validateGraphProjection,
  flame: validateFlameProjection,
  epilogue: validateEpilogueProjection,
} as const satisfies Record<Exclude<SnapshotProjectionKey, "participants">, DetailValidator<SnapshotProjection>>;

const validateSnapshotProjection = (key: SnapshotProjectionKey, value: unknown, issues: ValidationIssue[]): SnapshotProjection | undefined => {
  if (key === "participants") return validateParticipantProjections(value, `$.${key}`, issues);
  const result = SNAPSHOT_PROJECTION_VALIDATORS[key](value);
  if (result.ok) return result.value;
  issues.push(...remapProjectionIssues(result.issues, `$.${key}`));
  return undefined;
};

const validateSnapshotProjections = (input: DetailInput, issues: ValidationIssue[]): DetailInput => {
  const projections: DetailInput = {};
  for (const [key] of SNAPSHOT_PROJECTIONS) {
    const value = input[key];
    if (value === undefined) continue;
    const parsed = validateSnapshotProjection(key, value, issues);
    if (parsed !== undefined) projections[key] = parsed;
  }
  return projections;
};

const buildDiagnosticSnapshot = (input: DetailInput, reference: string, summary: DiagnosticSnapshotV1["summary"], operations: DiagnosticOperationDetail[], snapshotIssues: DiagnosticIssueDetail[], branches: DiagnosticBranchDetail[], projections: DetailInput): DiagnosticSnapshotV1 => {
  const snapshot: DetailInput = {
    schemaVersion: "DiagnosticSnapshot/v1",
    reference,
    environment: input.environment,
    state: input.state,
    capturedAt: input.capturedAt,
    committedCursor: input.committedCursor,
    projectedCursor: input.projectedCursor,
    filterFingerprint: input.filterFingerprint,
  };
  assignPresentFields(snapshot, input, ["runEndCursor"]);
  snapshot.summary = summary;
  snapshot.operations = operations;
  snapshot.issues = snapshotIssues;
  snapshot.branches = branches;
  assignPresentFields(snapshot, projections, ["participants", "run", "graph", "flame", "epilogue"]);
  assignPresentFields(snapshot, input, ["omissions"]);
  return snapshot as unknown as DiagnosticSnapshotV1;
};

export const validateDiagnosticSnapshot = (input: unknown): ValidationResult<DiagnosticSnapshotV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected snapshot object" }] };
  pushUnknownKeys(input, SNAPSHOT_KEYS, issues, "$");
  if (input.schemaVersion !== "DiagnosticSnapshot/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticSnapshot/v1" });
  const reference = validateReference(input.reference, "$.reference", issues);
  if (!checkEnum(input.environment, ENVIRONMENTS, "$.environment", issues)) return { ok: false, issues };
  if (!checkEnum(input.state, SNAPSHOT_STATES, "$.state", issues)) return { ok: false, issues };
  checkDateTime(input.capturedAt, "$.capturedAt", issues);
  checkOptionalNonNegativeIntegers(input, ["committedCursor", "projectedCursor", "runEndCursor"], "$", issues, (field) => `${field} must be non-negative`);
  const filterFingerprint = requireString(input, "filterFingerprint", issues);
  if (filterFingerprint !== undefined) checkSafeToken(filterFingerprint, "$.filterFingerprint", issues, 128);
  const summary = validateSummary(input.summary, "$.summary", issues);
  const hasOperationArray = checkBoundedArray(input.operations, "$.operations", issues, "operations must be a bounded array");
  const hasIssueArray = checkBoundedArray(input.issues, "$.issues", issues, "issues must be a bounded array");
  const hasBranchArray = checkBoundedArray(input.branches, "$.branches", issues, "branches must be a bounded array");
  const operations = hasOperationArray ? parseDetailArray(input.operations as unknown[], "$.operations", issues, validateDiagnosticOperation) : [];
  const snapshotIssues = hasIssueArray ? parseDetailArray(input.issues as unknown[], "$.issues", issues, validateDiagnosticIssue) : [];
  const branches = hasBranchArray ? parseDetailArray(input.branches as unknown[], "$.branches", issues, validateDiagnosticBranch) : [];
  const projections = validateSnapshotProjections(input, issues);
  checkOptionalBoundedStringArray(input, "omissions", issues);
  if (!reference || !summary || !isNonNegativeInteger(input.committedCursor) || !isNonNegativeInteger(input.projectedCursor) || !filterFingerprint || !hasOperationArray || !hasIssueArray || !hasBranchArray) return { ok: false, issues };
  return finishValidation(buildDiagnosticSnapshot(input, reference, summary, operations, snapshotIssues, branches, projections), issues);
};

export const parseDiagnosticSnapshot = (input: unknown): DiagnosticSnapshotV1 => parseOrThrow(validateDiagnosticSnapshot(input), "Invalid diagnostic snapshot");
export const validateSnapshot = validateDiagnosticSnapshot;
export const parseSnapshot = parseDiagnosticSnapshot;
export const validateDiagnosticSnapshotV1 = validateDiagnosticSnapshot;
export const parseDiagnosticSnapshotV1 = parseDiagnosticSnapshot;
