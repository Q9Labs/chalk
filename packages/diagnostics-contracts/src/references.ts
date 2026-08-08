import { ENVIRONMENTS, UNKNOWN_REASONS, isEnvironment, isSafeIdClass, MAX_SAFE_IDENTIFIER_LENGTH, SAFE_ID_CLASSES } from "./allowlists.js";
import { checkEnum, checkSafeToken, finishValidation, isNonNegativeInteger, isRecord, isString, parseOrThrow, requireString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import type { AlternateSafeId, DiagnosticReference, DiagnosticReferenceFocusKind, SafeIdentifier } from "./types.js";

const REFERENCE_PATTERN = /^chalkdiag:v1:(localhost|development|staging|production):([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?::(op|issue|event):([A-Za-z0-9][A-Za-z0-9_-]{0,127}))?(?:@([0-9]+))?$/;
const FOCUS_KINDS = ["op", "issue", "event"] as const satisfies readonly DiagnosticReferenceFocusKind[];

export const DIAGNOSTIC_REFERENCE_PREFIX = "chalkdiag:v1:";

export const formatDiagnosticReference = (reference: DiagnosticReference): string => {
  if (reference.version !== 1 || !isEnvironment(reference.environment)) throw new Error("Only v1 diagnostic references for an enabled environment are supported");
  if (!isSafeOpaqueId(reference.diagnosticId)) throw new Error("Diagnostic ID is not safe");
  let formatted = `${DIAGNOSTIC_REFERENCE_PREFIX}${reference.environment}:${reference.diagnosticId}`;
  if (reference.focus) {
    if (!FOCUS_KINDS.includes(reference.focus.kind)) throw new Error("Diagnostic focus kind is not supported");
    if (!isSafeOpaqueId(reference.focus.id)) throw new Error("Diagnostic focus ID is not safe");
    formatted += `:${reference.focus.kind}:${reference.focus.id}`;
  }
  if (reference.cursor !== undefined) {
    if (!isNonNegativeInteger(reference.cursor) || reference.cursor > Number.MAX_SAFE_INTEGER) throw new Error("Diagnostic cursor is not a safe integer");
    formatted += `@${reference.cursor}`;
  }
  return formatted;
};

export const parseDiagnosticReference = (input: unknown): DiagnosticReference => {
  if (typeof input !== "string") throw new Error("Diagnostic reference must be a string");
  const match = REFERENCE_PATTERN.exec(input);
  if (!match || !isEnvironment(match[1])) throw new Error("Malformed diagnostic reference");
  const environment = match[1];
  const diagnosticId = match[2];
  if (diagnosticId === undefined) throw new Error("Malformed diagnostic reference");
  const cursorText = match[5];
  if (cursorText !== undefined && ((cursorText.length > 1 && cursorText.startsWith("0")) || Number(cursorText) > Number.MAX_SAFE_INTEGER)) throw new Error("Diagnostic reference cursor is out of bounds");
  const reference: DiagnosticReference = {
    version: 1,
    environment,
    diagnosticId,
    ...(match[3] === undefined || match[4] === undefined ? {} : { focus: { kind: match[3] as DiagnosticReferenceFocusKind, id: match[4] } }),
    ...(cursorText === undefined ? {} : { cursor: Number(cursorText) }),
  };
  return reference;
};

export const tryParseDiagnosticReference = (input: unknown): ValidationResult<DiagnosticReference> => {
  try {
    return { ok: true, value: parseDiagnosticReference(input) };
  } catch (error) {
    return { ok: false, issues: [{ path: "$", message: error instanceof Error ? error.message : "Malformed diagnostic reference" }] };
  }
};

export const isDiagnosticReference = (input: unknown): input is string => tryParseDiagnosticReference(input).ok;

export const validateDiagnosticReferenceField = (input: Record<string, unknown>, key: string, issues: ValidationIssue[], path = "$"): string | undefined => {
  const reference = requireString(input, key, issues, path);
  if (reference === undefined) return undefined;
  try {
    parseDiagnosticReference(reference);
  } catch {
    issues.push({ path: `${path}.${key}`, message: "reference is malformed" });
  }
  return reference;
};

export const isSafeOpaqueId = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_SAFE_IDENTIFIER_LENGTH && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

const knownSafeIdClass = (idClass: unknown) => (typeof idClass === "string" ? SAFE_ID_CLASSES[idClass as keyof typeof SAFE_ID_CLASSES] : undefined);

const validateAlternateIdClass = (idClass: unknown, issues: ValidationIssue[]): void => {
  if (!isString(idClass) || !isSafeIdClass(idClass)) issues.push({ path: "$.idClass", message: "ID class is not a safe class name" });
};

const validateKnownAlternateValue = (idClass: unknown, value: unknown, issues: ValidationIssue[]): void => {
  if (!isString(idClass) || !isString(value)) return;
  const known = knownSafeIdClass(idClass);
  if (known && value.length > known.maxLength) issues.push({ path: "$.value", message: "ID exceeds the class limit" });
  if (known?.alphabet === "hex" && !/^[0-9a-f]+$/i.test(value)) issues.push({ path: "$.value", message: "hex ID contains non-hex characters" });
};

const validateAlternateIdValue = (idClass: unknown, value: unknown, issues: ValidationIssue[]): void => {
  if (!isString(value) || value.length === 0 || value.length > MAX_SAFE_IDENTIFIER_LENGTH) {
    issues.push({ path: "$.value", message: "ID value is not bounded" });
  }
  validateKnownAlternateValue(idClass, value, issues);
};

const validateAlternateStorage = (idClass: unknown, value: unknown, storage: unknown, issues: ValidationIssue[]): storage is "raw" | "hmac" => {
  if (!checkEnum(storage, ["raw", "hmac"] as const, "$.storage", issues)) return false;
  if (isString(idClass) && isString(value)) {
    const known = knownSafeIdClass(idClass);
    if (known && known.storage !== storage) issues.push({ path: "$.storage", message: `class ${idClass} requires ${known.storage} storage` });
  }
  return true;
};

const validateAlternateCopyability = (idClass: unknown, copyable: unknown, issues: ValidationIssue[]): copyable is boolean => {
  if (typeof copyable !== "boolean") {
    issues.push({ path: "$.copyable", message: "copyable must be boolean" });
    return false;
  }
  if (typeof idClass === "string") {
    const known = knownSafeIdClass(idClass);
    if (known && copyable !== known.copyable) issues.push({ path: "$.copyable", message: `class ${idClass} requires copyable=${known.copyable}` });
  }
  return true;
};

const validateAlternateOptionalFields = (input: Record<string, unknown>, storage: "raw" | "hmac", issues: ValidationIssue[]): boolean => {
  if (storage === "hmac" && input.hmacVersion !== undefined && !checkSafeToken(input.hmacVersion, "$.hmacVersion", issues, 32)) return false;
  if (input.unknownReason !== undefined) checkEnum(input.unknownReason, UNKNOWN_REASONS, "$.unknownReason", issues);
  return true;
};

export const validateAlternateSafeId = (input: unknown): ValidationResult<AlternateSafeId> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected an alternate ID object" }] };
  const idClass = input.idClass;
  const value = input.value;
  validateAlternateIdClass(idClass, issues);
  validateAlternateIdValue(idClass, value, issues);
  const storage = input.storage;
  if (!validateAlternateStorage(idClass, value, storage, issues)) return { ok: false, issues };
  const copyable = input.copyable;
  validateAlternateCopyability(idClass, copyable, issues);
  if (!validateAlternateOptionalFields(input, storage, issues)) return { ok: false, issues };
  if (issues.length > 0 || !isString(idClass) || !isString(value) || typeof copyable !== "boolean") return { ok: false, issues };
  return finishValidation({ idClass, value, storage, copyable, ...(input.hmacVersion === undefined ? {} : { hmacVersion: input.hmacVersion as string }), ...(input.unknownReason === undefined ? {} : { unknownReason: input.unknownReason as import("./types.js").SafeUnknownReason }) }, issues);
};

export const parseAlternateSafeId = (input: unknown): AlternateSafeId => parseOrThrow(validateAlternateSafeId(input), "Invalid alternate safe ID");

export const safeIdentifier = (idClass: string, value: string): SafeIdentifier => {
  const known = SAFE_ID_CLASSES[idClass as keyof typeof SAFE_ID_CLASSES];
  if (!known || known.storage === "raw") return { idClass, value, copyable: known?.copyable ?? true };
  return { idClass, value: undefined, copyable: false, unknownReason: "provider_opaque" };
};

export const opaqueReferenceId = (value: string): string => {
  if (!isSafeOpaqueId(value)) throw new Error("Reference ID is not safe");
  return value;
};

export const referenceEnvironments = ENVIRONMENTS;
