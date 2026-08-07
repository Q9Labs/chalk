import { CHECKPOINT_CLASSES, EVENT_SOURCES, MAX_PAGE_SIZE, SAFE_ID_CLASSES, UNKNOWN_REASONS } from "./allowlists.js";
import { checkDateTime, checkEnum, checkSafeToken, finishValidation, isBoolean, isFiniteNumber, isInteger, isNonNegativeInteger, isRecord, isString, parseOrThrow, pushUnknownKeys, requireString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import { validateAcceptedDiagnosticEvent } from "./events.js";
import { assignPresentFields, checkBoundedArray, parseDetailArray, validateReference, type DetailInput, type DetailValidator } from "./validation-helpers.js";
import type {
  AcceptedDiagnosticEvent,
  BranchKind,
  BranchState,
  CheckpointState,
  DiagnosticBranchDetail,
  DiagnosticCheckpointDetail,
  DiagnosticEventPageV1,
  DiagnosticAffectedSubject,
  DiagnosticIssueDetail,
  DiagnosticOperationDetail,
  DiagnosticOperationPageV1,
  IssueSeverity,
  IssueState,
  OperationState,
  SafeIdentifier,
} from "./types.js";

const OPERATION_STATES = ["running", "retrying", "succeeded", "failed", "stalled", "cancelled", "timed_out"] as const satisfies readonly OperationState[];
const CHECKPOINT_STATES = ["pending", "observed", "missed", "not_observable", "late_observed"] as const satisfies readonly CheckpointState[];
const ISSUE_SEVERITIES = ["info", "warning", "error", "critical"] as const satisfies readonly IssueSeverity[];
const ISSUE_STATES = ["open", "resolved"] as const satisfies readonly IssueState[];
const BRANCH_KINDS = ["cleanup", "recording", "transcription", "artifact", "webhook"] as const satisfies readonly BranchKind[];
const BRANCH_STATES = ["pending", "running", "succeeded", "failed", "cancelled", "timed_out"] as const satisfies readonly BranchState[];
const OPERATION_KEYS = [
  "schemaVersion",
  "id",
  "reference",
  "diagnosticReference",
  "parentId",
  "branchId",
  "kind",
  "expectationVersion",
  "state",
  "attempt",
  "retryGroup",
  "startedAt",
  "deadlineAt",
  "graceEndsAt",
  "endedAt",
  "durationMilliseconds",
  "checkpoints",
  "errorClass",
  "requestId",
  "commandId",
  "providerId",
  "journeyId",
  "traceId",
  "spanId",
  "source",
  "releaseId",
  "sourceCommit",
  "clockUncertainty",
  "visibilityGaps",
] as const;
const CHECKPOINT_KEYS = ["key", "class", "displayOrder", "state", "deadlineAt", "evidenceCursor", "unknownReason", "predicate"] as const;
const ISSUE_KEYS = ["schemaVersion", "id", "reference", "diagnosticReference", "operationId", "affected", "kind", "severity", "state", "summary", "firstObservedAt", "lastObservedAt", "resolvedAt", "lastConfirmedCheckpoint", "missingCheckpoint", "retryState", "unknownReason"] as const;
const BRANCH_KEYS = ["schemaVersion", "id", "reference", "kind", "state", "leaseEndsAt", "startedAt", "terminalAt", "terminalCursor", "attempts", "fanInChildren", "lateObservations", "unknownReason"] as const;

type FieldValidator = (value: unknown, path: string, key: string, issues: ValidationIssue[]) => void;

const checkOptionalFields = (input: DetailInput, keys: readonly string[], path: string, issues: ValidationIssue[], validate: FieldValidator): void => {
  for (const key of keys) {
    if (input[key] !== undefined) validate(input[key], `${path}.${key}`, key, issues);
  }
};

const checkOptionalDateTimes = (input: DetailInput, keys: readonly string[], path: string, issues: ValidationIssue[]): void => {
  checkOptionalFields(input, keys, path, issues, (value, valuePath, _key, target) => {
    checkDateTime(value, valuePath, target);
  });
};

const checkOptionalSafeTokens = (input: DetailInput, keys: readonly string[], path: string, issues: ValidationIssue[], maxLength: number): void => {
  checkOptionalFields(input, keys, path, issues, (value, valuePath, _key, target) => {
    checkSafeToken(value, valuePath, target, maxLength);
  });
};

const checkSafeTokenWhenPresent = (value: unknown, path: string, issues: ValidationIssue[], maxLength: number): void => {
  if (value !== undefined) checkSafeToken(value, path, issues, maxLength);
};

const checkPositiveInteger = (value: unknown, path: string, issues: ValidationIssue[]): void => {
  if (!isInteger(value) || value < 1) issues.push({ path, message: "expectationVersion must be positive" });
};

const checkNonNegativeInteger = (value: unknown, path: string, issues: ValidationIssue[], message: string): void => {
  if (!isNonNegativeInteger(value)) issues.push({ path, message });
};

const checkOptionalNonNegativeNumber = (value: unknown, path: string, issues: ValidationIssue[], message: string): void => {
  if (value !== undefined && (!isFiniteNumber(value) || value < 0)) issues.push({ path, message });
};

const checkOptionalBoundedString = (value: unknown, path: string, issues: ValidationIssue[], message: string, maxLength: number): void => {
  if (value !== undefined && (!isString(value) || value.length > maxLength)) issues.push({ path, message });
};

const checkOptionalNonNegativeIntegers = (input: DetailInput, keys: readonly string[], path: string, issues: ValidationIssue[], message: (key: string) => string): void => {
  checkOptionalFields(input, keys, path, issues, (value, valuePath, key, target) => {
    if (!isNonNegativeInteger(value)) target.push({ path: valuePath, message: message(key) });
  });
};

const checkOptionalSafeIdentifiers = (input: DetailInput, keys: readonly string[], path: string, issues: ValidationIssue[]): void => {
  checkOptionalFields(input, keys, path, issues, (value, valuePath, _key, target) => {
    validateIdentifier(value, valuePath, target);
  });
};

const parseBoundedDetailArray = <T>(value: unknown, path: string, issues: ValidationIssue[], message: string, validate: DetailValidator<T>): { present: boolean; values: T[] } => {
  const array = checkBoundedArray(value, path, issues, message);
  if (!array) return { present: false, values: [] };
  return { present: true, values: parseDetailArray(value as unknown[], path, issues, validate) };
};

const isBoundedStringArray = (value: unknown, maxLength: number): value is string[] => Array.isArray(value) && !value.some((item) => !isString(item) || item.length > maxLength);

const checkOptionalBoundedStringArray = (input: DetailInput, key: string, path: string, issues: ValidationIssue[], maxLength: number, message: string): void => {
  if (input[key] !== undefined && !isBoundedStringArray(input[key], maxLength)) issues.push({ path: `${path}.${key}`, message });
};

const checkOptionalSchemaVersion = (input: DetailInput, key: string, expected: string, path: string, issues: ValidationIssue[]): void => {
  if (input[key] !== undefined && input[key] !== expected) issues.push({ path: `${path}.${key}`, message: `expected ${expected}` });
};

const checkOptionalReferences = (input: DetailInput, keys: readonly string[], path: string, issues: ValidationIssue[]): void => {
  checkOptionalFields(input, keys, path, issues, (value, valuePath, _key, target) => {
    validateReference(value, valuePath, target);
  });
};

const validateIdentifierString = (value: string, path: string, issues: ValidationIssue[]): string => {
  if (value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:@+/=-]*$/.test(value)) issues.push({ path, message: "identifier is not safe" });
  return value;
};

const validateUnknownIdentifierClass = (value: DetailInput, path: string, issues: ValidationIssue[]): void => {
  if (value.value !== undefined) issues.push({ path: `${path}.value`, message: "unknown identifier classes cannot expose a value" });
  if (value.copyable !== false) issues.push({ path: `${path}.copyable`, message: "unknown identifier classes are not copyable" });
};

const validateHmacIdentifierClass = (value: DetailInput, path: string, issues: ValidationIssue[]): void => {
  if (value.value !== undefined) issues.push({ path: `${path}.value`, message: "HMAC-only identifier classes cannot expose a value" });
  if (value.copyable !== false) issues.push({ path: `${path}.copyable`, message: "HMAC-only identifier classes are not copyable" });
};

const validateRawIdentifierClass = (value: DetailInput, idClass: string, rule: { copyable: boolean; maxLength: number }, path: string, issues: ValidationIssue[]): void => {
  if (value.value === undefined) issues.push({ path: `${path}.value`, message: "raw safe identifier classes require a value" });
  if (value.copyable !== rule.copyable) issues.push({ path: `${path}.copyable`, message: `identifier class ${idClass} requires copyable=${rule.copyable}` });
  if (isString(value.value) && value.value.length > rule.maxLength) issues.push({ path: `${path}.value`, message: "identifier exceeds the class limit" });
};

const validateIdentifierClass = (value: DetailInput, idClass: string | undefined, path: string, issues: ValidationIssue[]): void => {
  if (!idClass) return;
  const rule = SAFE_ID_CLASSES[idClass as keyof typeof SAFE_ID_CLASSES];
  if (!rule) {
    validateUnknownIdentifierClass(value, path, issues);
    return;
  }
  if (rule.storage === "hmac") {
    validateHmacIdentifierClass(value, path, issues);
    return;
  }
  validateRawIdentifierClass(value, idClass, rule, path, issues);
};

const validateIdentifierObjectValue = (value: DetailInput, path: string, issues: ValidationIssue[]): boolean => {
  if (value.value !== undefined && (!isString(value.value) || value.value.length > 160)) issues.push({ path: `${path}.value`, message: "identifier value must be a bounded string" });
  return value.unknownReason === undefined || checkEnum(value.unknownReason, UNKNOWN_REASONS, `${path}.unknownReason`, issues);
};

const validateIdentifierCopyable = (value: DetailInput, path: string, issues: ValidationIssue[]): void => {
  if (typeof value.copyable !== "boolean") issues.push({ path: `${path}.copyable`, message: "copyable must be boolean" });
  if (value.copyable === true && value.value === undefined) issues.push({ path: `${path}.value`, message: "copyable identifiers require a value" });
  if (value.copyable === false && value.unknownReason === undefined) issues.push({ path: `${path}.unknownReason`, message: "non-copyable identifiers require an unknown reason" });
};

const validateIdentifierObject = (value: DetailInput, path: string, issues: ValidationIssue[]): SafeIdentifier | undefined => {
  pushUnknownKeys(value, ["idClass", "value", "unknownReason", "copyable"], issues, path);
  const idClass = requireString(value, "idClass", issues, path);
  checkSafeTokenWhenPresent(idClass, `${path}.idClass`, issues, 96);
  if (!validateIdentifierObjectValue(value, path, issues)) return undefined;
  validateIdentifierCopyable(value, path, issues);
  validateIdentifierClass(value, idClass, path, issues);
  if (!idClass || typeof value.copyable !== "boolean") return undefined;
  return { idClass, ...(value.value === undefined ? {} : { value: value.value as string }), copyable: value.copyable, ...(value.unknownReason === undefined ? {} : { unknownReason: value.unknownReason as SafeIdentifier["unknownReason"] }) };
};

const validateIdentifier = (value: unknown, path: string, issues: ValidationIssue[]): SafeIdentifier | string | undefined => {
  if (isString(value)) return validateIdentifierString(value, path, issues);
  if (!isRecord(value)) {
    issues.push({ path, message: "expected an identifier or safe identifier object" });
    return undefined;
  }
  return validateIdentifierObject(value, path, issues);
};

const validateAffectedSubject = (value: unknown, path: string, issues: ValidationIssue[]): DiagnosticAffectedSubject | undefined => {
  if (!isRecord(value)) {
    issues.push({ path, message: "expected an affected subject object" });
    return undefined;
  }
  pushUnknownKeys(value, ["kind", "identifier"], issues, path);
  if (!checkEnum(value.kind, ["participant", "service"] as const, `${path}.kind`, issues)) return undefined;
  const identifier = validateIdentifier(value.identifier, `${path}.identifier`, issues);
  if (!identifier || isString(identifier)) {
    if (isString(identifier)) issues.push({ path: `${path}.identifier`, message: "affected subjects require a safe identifier object" });
    return undefined;
  }
  return { kind: value.kind, identifier };
};

const buildDiagnosticCheckpoint = (input: DetailInput, key: string, displayOrder: number): DiagnosticCheckpointDetail => {
  const checkpoint: DetailInput = {
    key,
    class: input.class,
    displayOrder,
    state: input.state,
  };
  assignPresentFields(checkpoint, input, ["deadlineAt", "evidenceCursor", "unknownReason", "predicate"]);
  return checkpoint as unknown as DiagnosticCheckpointDetail;
};

export const validateDiagnosticCheckpoint = (input: unknown, path = "$"): ValidationResult<DiagnosticCheckpointDetail> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path, message: "expected checkpoint object" }] };
  pushUnknownKeys(input, CHECKPOINT_KEYS, issues, path);
  const key = requireString(input, "key", issues, path);
  if (key !== undefined) checkSafeToken(key, `${path}.key`, issues, 96);
  if (!checkEnum(input.class, CHECKPOINT_CLASSES, `${path}.class`, issues)) return { ok: false, issues };
  const displayOrder = input.displayOrder;
  if (!isNonNegativeInteger(displayOrder)) issues.push({ path: `${path}.displayOrder`, message: "displayOrder must be a non-negative integer" });
  if (!checkEnum(input.state, CHECKPOINT_STATES, `${path}.state`, issues)) return { ok: false, issues };
  checkOptionalDateTimes(input, ["deadlineAt"], path, issues);
  checkOptionalNonNegativeIntegers(input, ["evidenceCursor"], path, issues, (field) => `${field} must be a non-negative integer`);
  if (input.unknownReason !== undefined && !checkEnum(input.unknownReason, UNKNOWN_REASONS, `${path}.unknownReason`, issues)) return { ok: false, issues };
  if (input.predicate !== undefined && (!isString(input.predicate) || input.predicate.length > 160)) issues.push({ path: `${path}.predicate`, message: "predicate is too long" });
  if (!key || !isNonNegativeInteger(displayOrder)) return { ok: false, issues };
  return finishValidation(buildDiagnosticCheckpoint(input, key, displayOrder), issues);
};
export const parseDiagnosticCheckpoint = (input: unknown): DiagnosticCheckpointDetail => parseOrThrow(validateDiagnosticCheckpoint(input), "Invalid diagnostic checkpoint");

const buildDiagnosticOperation = (input: DetailInput, id: string, kind: string, expectationVersion: number, attempt: number, startedAt: string, checkpoints: DiagnosticCheckpointDetail[]): DiagnosticOperationDetail => {
  const operation: DetailInput = {};
  if (input.schemaVersion !== undefined) operation.schemaVersion = "OperationDetail/v1";
  operation.id = id;
  assignPresentFields(operation, input, ["reference", "diagnosticReference", "parentId", "branchId"]);
  operation.kind = kind;
  operation.expectationVersion = expectationVersion;
  operation.state = input.state;
  operation.attempt = attempt;
  assignPresentFields(operation, input, ["retryGroup"]);
  operation.startedAt = startedAt;
  assignPresentFields(operation, input, ["deadlineAt", "graceEndsAt", "endedAt", "durationMilliseconds"]);
  operation.checkpoints = checkpoints;
  assignPresentFields(operation, input, ["errorClass"]);
  assignPresentFields(operation, input, ["requestId", "commandId", "providerId", "journeyId", "traceId", "spanId"]);
  operation.source = input.source;
  assignPresentFields(operation, input, ["releaseId", "sourceCommit", "clockUncertainty", "visibilityGaps"]);
  return operation as unknown as DiagnosticOperationDetail;
};

export const validateDiagnosticOperation = (input: unknown, path = "$"): ValidationResult<DiagnosticOperationDetail> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path, message: "expected operation object" }] };
  pushUnknownKeys(input, OPERATION_KEYS, issues, path);
  checkOptionalSchemaVersion(input, "schemaVersion", "OperationDetail/v1", path, issues);
  const id = requireString(input, "id", issues, path);
  checkSafeTokenWhenPresent(id, `${path}.id`, issues, 128);
  checkOptionalReferences(input, ["reference", "diagnosticReference"], path, issues);
  checkOptionalSafeTokens(input, ["parentId", "branchId"], path, issues, 128);
  const kind = requireString(input, "kind", issues, path);
  checkSafeTokenWhenPresent(kind, `${path}.kind`, issues, 128);
  const expectationVersion = input.expectationVersion;
  checkPositiveInteger(expectationVersion, `${path}.expectationVersion`, issues);
  if (!checkEnum(input.state, OPERATION_STATES, `${path}.state`, issues)) return { ok: false, issues };
  const attempt = input.attempt;
  checkNonNegativeInteger(attempt, `${path}.attempt`, issues, "attempt must be non-negative");
  const startedAt = input.startedAt;
  checkDateTime(startedAt, `${path}.startedAt`, issues);
  checkOptionalDateTimes(input, ["deadlineAt", "graceEndsAt", "endedAt"], path, issues);
  checkOptionalNonNegativeNumber(input.durationMilliseconds, `${path}.durationMilliseconds`, issues, "duration must be non-negative");
  checkOptionalSafeTokens(input, ["errorClass"], path, issues, 128);
  const checkpointsInput = input.checkpoints;
  const checkpointResult = parseBoundedDetailArray(checkpointsInput, `${path}.checkpoints`, issues, "checkpoints must be a bounded array", validateDiagnosticCheckpoint);
  const { present: hasCheckpoints, values: checkpoints } = checkpointResult;
  checkOptionalSafeIdentifiers(input, ["retryGroup", "requestId", "commandId", "providerId", "journeyId", "traceId", "spanId"], path, issues);
  if (!checkEnum(input.source, EVENT_SOURCES, `${path}.source`, issues)) return { ok: false, issues };
  checkOptionalSafeTokens(input, ["releaseId", "sourceCommit"], path, issues, 160);
  checkOptionalBoundedString(input.clockUncertainty, `${path}.clockUncertainty`, issues, "clockUncertainty is too long", 160);
  checkOptionalBoundedStringArray(input, "visibilityGaps", path, issues, 160, "visibilityGaps must be bounded strings");
  if (!id || !kind || !isInteger(expectationVersion) || !isNonNegativeInteger(attempt) || !startedAt || !hasCheckpoints) return { ok: false, issues };
  return finishValidation(buildDiagnosticOperation(input, id, kind, expectationVersion, attempt, startedAt as string, checkpoints), issues);
};
export const parseDiagnosticOperation = (input: unknown): DiagnosticOperationDetail => parseOrThrow(validateDiagnosticOperation(input), "Invalid diagnostic operation");
export const validateOperationDetail = validateDiagnosticOperation;
export const parseOperationDetail = parseDiagnosticOperation;
export const validateOperationDetailV1 = validateDiagnosticOperation;
export const parseOperationDetailV1 = parseDiagnosticOperation;

const buildDiagnosticIssue = (input: DetailInput, id: string, affected: DiagnosticAffectedSubject | undefined, kind: string, summary: string, firstObservedAt: string): DiagnosticIssueDetail => {
  const issue: DetailInput = {};
  if (input.schemaVersion !== undefined) issue.schemaVersion = "IssueDetail/v1";
  issue.id = id;
  assignPresentFields(issue, input, ["reference", "diagnosticReference", "operationId"]);
  if (affected !== undefined) issue.affected = affected;
  issue.kind = kind;
  issue.severity = input.severity;
  issue.state = input.state;
  issue.summary = summary;
  issue.firstObservedAt = firstObservedAt;
  assignPresentFields(issue, input, ["lastObservedAt", "resolvedAt", "lastConfirmedCheckpoint", "missingCheckpoint", "retryState", "unknownReason"]);
  return issue as unknown as DiagnosticIssueDetail;
};

export const validateDiagnosticIssue = (input: unknown, path = "$"): ValidationResult<DiagnosticIssueDetail> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path, message: "expected issue object" }] };
  pushUnknownKeys(input, ISSUE_KEYS, issues, path);
  checkOptionalSchemaVersion(input, "schemaVersion", "IssueDetail/v1", path, issues);
  const id = requireString(input, "id", issues, path);
  if (id !== undefined) checkSafeToken(id, `${path}.id`, issues, 128);
  checkOptionalReferences(input, ["reference", "diagnosticReference"], path, issues);
  checkOptionalSafeTokens(input, ["operationId"], path, issues, 128);
  const affected = input.affected === undefined ? undefined : validateAffectedSubject(input.affected, `${path}.affected`, issues);
  const kind = requireString(input, "kind", issues, path);
  if (kind !== undefined) checkSafeToken(kind, `${path}.kind`, issues, 96);
  if (!checkEnum(input.severity, ISSUE_SEVERITIES, `${path}.severity`, issues)) return { ok: false, issues };
  if (!checkEnum(input.state, ISSUE_STATES, `${path}.state`, issues)) return { ok: false, issues };
  const summary = requireString(input, "summary", issues, path);
  if (summary !== undefined && summary.length > 256) issues.push({ path: `${path}.summary`, message: "summary is too long" });
  const firstObservedAt = input.firstObservedAt;
  checkDateTime(firstObservedAt, `${path}.firstObservedAt`, issues);
  checkOptionalDateTimes(input, ["lastObservedAt", "resolvedAt"], path, issues);
  checkOptionalSafeTokens(input, ["lastConfirmedCheckpoint", "missingCheckpoint", "retryState"], path, issues, 128);
  if (input.unknownReason !== undefined && !checkEnum(input.unknownReason, UNKNOWN_REASONS, `${path}.unknownReason`, issues)) return { ok: false, issues };
  if (!id || !kind || !summary || !firstObservedAt) return { ok: false, issues };
  return finishValidation(buildDiagnosticIssue(input, id, affected, kind, summary, firstObservedAt as string), issues);
};
export const parseDiagnosticIssue = (input: unknown): DiagnosticIssueDetail => parseOrThrow(validateDiagnosticIssue(input), "Invalid diagnostic issue");
export const validateIssueDetail = validateDiagnosticIssue;
export const parseIssueDetail = parseDiagnosticIssue;
export const validateIssueDetailV1 = validateDiagnosticIssue;
export const parseIssueDetailV1 = parseDiagnosticIssue;

const buildDiagnosticBranch = (input: DetailInput, id: string, leaseEndsAt: string): DiagnosticBranchDetail => {
  const branch: DetailInput = {};
  if (input.schemaVersion !== undefined) branch.schemaVersion = "BranchDetail/v1";
  branch.id = id;
  assignPresentFields(branch, input, ["reference"]);
  branch.kind = input.kind;
  branch.state = input.state;
  branch.leaseEndsAt = leaseEndsAt;
  assignPresentFields(branch, input, ["startedAt", "terminalAt", "terminalCursor"]);
  branch.attempts = input.attempts;
  assignPresentFields(branch, input, ["fanInChildren", "lateObservations", "unknownReason"]);
  return branch as unknown as DiagnosticBranchDetail;
};

export const validateDiagnosticBranch = (input: unknown, path = "$"): ValidationResult<DiagnosticBranchDetail> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path, message: "expected branch object" }] };
  pushUnknownKeys(input, BRANCH_KEYS, issues, path);
  checkOptionalSchemaVersion(input, "schemaVersion", "BranchDetail/v1", path, issues);
  const id = requireString(input, "id", issues, path);
  if (id !== undefined) checkSafeToken(id, `${path}.id`, issues, 128);
  checkOptionalReferences(input, ["reference"], path, issues);
  if (!checkEnum(input.kind, BRANCH_KINDS, `${path}.kind`, issues)) return { ok: false, issues };
  if (!checkEnum(input.state, BRANCH_STATES, `${path}.state`, issues)) return { ok: false, issues };
  const leaseEndsAt = input.leaseEndsAt;
  checkDateTime(leaseEndsAt, `${path}.leaseEndsAt`, issues);
  checkOptionalDateTimes(input, ["startedAt", "terminalAt"], path, issues);
  checkOptionalNonNegativeIntegers(input, ["terminalCursor", "attempts", "lateObservations"], path, issues, (field) => `${field} must be non-negative`);
  checkOptionalBoundedStringArray(input, "fanInChildren", path, issues, 128, "fanInChildren must be bounded IDs");
  if (input.unknownReason !== undefined && !checkEnum(input.unknownReason, UNKNOWN_REASONS, `${path}.unknownReason`, issues)) return { ok: false, issues };
  if (!id || !leaseEndsAt || !isNonNegativeInteger(input.attempts)) return { ok: false, issues };
  return finishValidation(buildDiagnosticBranch(input, id, leaseEndsAt as string), issues);
};
export const parseDiagnosticBranch = (input: unknown): DiagnosticBranchDetail => parseOrThrow(validateDiagnosticBranch(input), "Invalid diagnostic branch");
export const validateBranchDetail = validateDiagnosticBranch;
export const parseBranchDetail = parseDiagnosticBranch;
export const validateBranchDetailV1 = validateDiagnosticBranch;
export const parseBranchDetailV1 = parseDiagnosticBranch;

const validateAcceptedEvents = (events: unknown, path: string, issues: ValidationIssue[]): AcceptedDiagnosticEvent[] => {
  if (!Array.isArray(events) || events.length > MAX_PAGE_SIZE) {
    issues.push({ path, message: `events must contain at most ${MAX_PAGE_SIZE} rows` });
    return [];
  }
  const parsed: AcceptedDiagnosticEvent[] = [];
  for (const [index, event] of events.entries()) {
    const result = validateAcceptedDiagnosticEvent(event);
    if (result.ok) parsed.push(result.value);
    else issues.push(...result.issues.map((issue) => ({ ...issue, path: `${path}[${index}]${issue.path === "$" ? "" : issue.path.slice(1)}` })));
  }
  return parsed;
};

const validatePageControls = (input: DetailInput, cursorKeys: readonly string[], issues: ValidationIssue[]): string | undefined => {
  checkOptionalNonNegativeIntegers(input, cursorKeys, "$", issues, (field) => `${field} must be non-negative`);
  if (!isBoolean(input.hasMore)) issues.push({ path: "$.hasMore", message: "hasMore must be boolean" });
  const filterFingerprint = requireString(input, "filterFingerprint", issues);
  if (filterFingerprint !== undefined) checkSafeToken(filterFingerprint, "$.filterFingerprint", issues, 128);
  return filterFingerprint;
};

const buildDiagnosticEventPage = (input: DetailInput, reference: string, events: AcceptedDiagnosticEvent[], filterFingerprint: string): DiagnosticEventPageV1 => {
  const page: DetailInput = {
    schemaVersion: "DiagnosticEventPage/v1",
    reference,
    events,
    committedCursor: input.committedCursor,
    projectedCursor: input.projectedCursor,
  };
  assignPresentFields(page, input, ["afterCursor", "beforeCursor", "nextCursor"]);
  page.hasMore = input.hasMore;
  page.filterFingerprint = filterFingerprint;
  return page as unknown as DiagnosticEventPageV1;
};

export const validateDiagnosticEventPage = (input: unknown): ValidationResult<DiagnosticEventPageV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected Event page object" }] };
  const keys = ["schemaVersion", "reference", "events", "committedCursor", "projectedCursor", "afterCursor", "beforeCursor", "nextCursor", "hasMore", "filterFingerprint"] as const;
  pushUnknownKeys(input, keys, issues, "$");
  if (input.schemaVersion !== "DiagnosticEventPage/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticEventPage/v1" });
  const reference = validateReference(input.reference, "$.reference", issues);
  const events = validateAcceptedEvents(input.events, "$.events", issues);
  const filterFingerprint = validatePageControls(input, ["committedCursor", "projectedCursor", "afterCursor", "beforeCursor", "nextCursor"], issues);
  if (!reference || !isNonNegativeInteger(input.committedCursor) || !isNonNegativeInteger(input.projectedCursor) || !isBoolean(input.hasMore) || !filterFingerprint) return { ok: false, issues };
  return finishValidation(buildDiagnosticEventPage(input, reference, events, filterFingerprint), issues);
};
export const parseDiagnosticEventPage = (input: unknown): DiagnosticEventPageV1 => parseOrThrow(validateDiagnosticEventPage(input), "Invalid diagnostic Event page");
export const validateEventPage = validateDiagnosticEventPage;
export const parseEventPage = parseDiagnosticEventPage;
export const validateDiagnosticEventPageV1 = validateDiagnosticEventPage;
export const parseDiagnosticEventPageV1 = parseDiagnosticEventPage;

const buildDiagnosticOperationPage = (input: DetailInput, reference: string, operations: DiagnosticOperationDetail[], filterFingerprint: string): DiagnosticOperationPageV1 => {
  const page: DetailInput = {
    schemaVersion: "DiagnosticOperationPage/v1",
    reference,
    operations,
    committedCursor: input.committedCursor,
    projectedCursor: input.projectedCursor,
  };
  assignPresentFields(page, input, ["nextCursor"]);
  page.hasMore = input.hasMore;
  page.filterFingerprint = filterFingerprint;
  return page as unknown as DiagnosticOperationPageV1;
};

export const validateDiagnosticOperationPage = (input: unknown): ValidationResult<DiagnosticOperationPageV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected operation page object" }] };
  const keys = ["schemaVersion", "reference", "operations", "committedCursor", "projectedCursor", "nextCursor", "hasMore", "filterFingerprint"] as const;
  pushUnknownKeys(input, keys, issues, "$");
  if (input.schemaVersion !== "DiagnosticOperationPage/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticOperationPage/v1" });
  const reference = validateReference(input.reference, "$.reference", issues);
  const hasOperations = checkBoundedArray(input.operations, "$.operations", issues, "operations must be bounded");
  const operations = hasOperations ? parseDetailArray(input.operations as unknown[], "$.operations", issues, validateDiagnosticOperation) : [];
  const filterFingerprint = validatePageControls(input, ["committedCursor", "projectedCursor", "nextCursor"], issues);
  if (!reference || !hasOperations || !isNonNegativeInteger(input.committedCursor) || !isNonNegativeInteger(input.projectedCursor) || !isBoolean(input.hasMore) || !filterFingerprint) return { ok: false, issues };
  return finishValidation(buildDiagnosticOperationPage(input, reference, operations, filterFingerprint), issues);
};
export const parseDiagnosticOperationPage = (input: unknown): DiagnosticOperationPageV1 => parseOrThrow(validateDiagnosticOperationPage(input), "Invalid diagnostic operation page");
