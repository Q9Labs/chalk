import { sha256 } from "@noble/hashes/sha2.js";
import { EVENT_NAME_EXTRA_ROOTS, EVENT_PHASES, EVENT_SOURCES, EVENT_STATES, MAX_DIAGNOSTIC_EVENT_BYTES, MAX_EVENT_ID_LENGTH, MAX_EVENT_NAME_LENGTH, MAX_OPERATION_REF_LENGTH, MAX_PHASE_LENGTH, isAllowedPhase } from "./allowlists.js";
import { ACTION_OPERATION_KEYS } from "./actions.js";
import { redactDiagnosticAttributes, validateDiagnosticAttributes } from "./safety.js";
import { checkDateTime, checkEnum, checkSafeToken, finishValidation, isInteger, isNonNegativeInteger, isRecord, isString, parseOrThrow, pushUnknownKeys, requireString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import type { AcceptedDiagnosticEvent, DiagnosticEventCorrelation, DiagnosticEventDraft, DiagnosticEventExpectation, DiagnosticRelease } from "./types.js";

const DRAFT_KEYS = ["version", "eventId", "producerOperationRef", "parentProducerOperationRef", "producerSequence", "occurredAt", "source", "name", "phase", "state", "expectation", "correlation", "release", "attributes"] as const;
const EXPECTATION_KEYS = ["name", "version", "checkpoint", "checkpointClass", "deadlineAt"] as const;
const CORRELATION_KEYS = ["journeyId", "traceId", "spanId", "requestId", "commandId", "providerId", "retryGroupRef", "attempt"] as const;
const RELEASE_KEYS = ["id", "sourceCommit"] as const;
const ACCEPTED_KEYS = [...DRAFT_KEYS, "diagnosticId", "cursor", "receivedAt", "fingerprint"] as const;

export const isAllowedDiagnosticEventName = (name: string): boolean => {
  const roots = [...ACTION_OPERATION_KEYS, ...EVENT_NAME_EXTRA_ROOTS];
  return roots.some((root) => name === root || name.startsWith(`${root}.`));
};

export const ALLOWED_EVENT_NAMES: readonly string[] = [...ACTION_OPERATION_KEYS, ...EVENT_NAME_EXTRA_ROOTS];
export const ALLOWED_EVENT_PHASES = EVENT_PHASES;

type ExpectationBase = Readonly<{ name?: string; version: unknown; checkpoint: string; checkpointClass: DiagnosticEventExpectation["checkpointClass"] }>;

const parseExpectationBase = (input: Record<string, unknown>, issues: ValidationIssue[], path: string): ExpectationBase | undefined => {
  const name = requireString(input, "name", issues, path);
  const version = input.version;
  if (!isInteger(version) || version < 1 || version > 255) issues.push({ path: `${path}.version`, message: "expected a positive expectation version" });
  const checkpoint = input.checkpoint;
  if (!checkSafeToken(checkpoint, `${path}.checkpoint`, issues, 96)) return undefined;
  const checkpointClass = input.checkpointClass;
  if (!checkEnum(checkpointClass, ["required", "conditional", "best_effort"] as const, `${path}.checkpointClass`, issues)) return undefined;
  return { name, version, checkpoint, checkpointClass };
};

const validateExpectation = (input: unknown, issues: ValidationIssue[], path: string): DiagnosticEventExpectation | undefined => {
  if (!isRecord(input)) {
    issues.push({ path, message: "expected an expectation object" });
    return undefined;
  }
  pushUnknownKeys(input, EXPECTATION_KEYS, issues, path);
  const base = parseExpectationBase(input, issues, path);
  if (!base) return undefined;
  if (input.deadlineAt !== undefined) checkDateTime(input.deadlineAt, `${path}.deadlineAt`, issues);
  if (!base.name || !isInteger(base.version)) return undefined;
  return {
    name: base.name,
    version: base.version,
    checkpoint: base.checkpoint,
    checkpointClass: base.checkpointClass,
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt as string }),
  };
};

const parseCorrelationValue = (key: (typeof CORRELATION_KEYS)[number], value: unknown, path: string, issues: ValidationIssue[]): string | number | undefined => {
  if (key === "attempt") {
    if (isNonNegativeInteger(value) && value <= 1_000_000) return value;
    issues.push({ path: `${path}.${key}`, message: "attempt must be a bounded non-negative integer" });
    return undefined;
  }
  if (isString(value) && value.length > 0 && value.length <= MAX_OPERATION_REF_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._:@+/=-]*$/.test(value)) return value;
  issues.push({ path: `${path}.${key}`, message: "correlation ID is not a safe token" });
  return undefined;
};

const validateCorrelation = (input: unknown, issues: ValidationIssue[], path: string): DiagnosticEventCorrelation | undefined => {
  if (!isRecord(input)) {
    issues.push({ path, message: "expected a correlation object" });
    return undefined;
  }
  pushUnknownKeys(input, CORRELATION_KEYS, issues, path);
  const correlation: Record<string, string | number> = {};
  for (const key of CORRELATION_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    const parsed = parseCorrelationValue(key, value, path, issues);
    if (parsed !== undefined) correlation[key] = parsed;
  }
  return correlation as DiagnosticEventCorrelation;
};

const validateRelease = (input: unknown, issues: ValidationIssue[], path: string): DiagnosticRelease | undefined => {
  if (!isRecord(input)) {
    issues.push({ path, message: "expected a release object" });
    return undefined;
  }
  pushUnknownKeys(input, RELEASE_KEYS, issues, path);
  const id = requireString(input, "id", issues, path);
  if (id !== undefined) checkSafeToken(id, `${path}.id`, issues, 128);
  if (input.sourceCommit !== undefined) checkSafeToken(input.sourceCommit, `${path}.sourceCommit`, issues, 128);
  if (!id) return undefined;
  return {
    id,
    ...(input.sourceCommit === undefined ? {} : { sourceCommit: input.sourceCommit as string }),
  };
};

const validateDraftIdentity = (input: Record<string, unknown>, issues: ValidationIssue[]): string | undefined => {
  if (input.version !== 1) issues.push({ path: "$.version", message: "only event contract version 1 is supported" });
  const eventId = requireString(input, "eventId", issues);
  if (eventId !== undefined) checkSafeToken(eventId, "$.eventId", issues, MAX_EVENT_ID_LENGTH);
  if (input.producerOperationRef !== undefined) checkSafeToken(input.producerOperationRef, "$.producerOperationRef", issues, MAX_OPERATION_REF_LENGTH);
  if (input.parentProducerOperationRef !== undefined) checkSafeToken(input.parentProducerOperationRef, "$.parentProducerOperationRef", issues, MAX_OPERATION_REF_LENGTH);
  const producerSequence = input.producerSequence;
  if (!isNonNegativeInteger(producerSequence) || producerSequence > Number.MAX_SAFE_INTEGER) issues.push({ path: "$.producerSequence", message: "producerSequence must be a safe non-negative integer" });
  checkDateTime(input.occurredAt, "$.occurredAt", issues);
  return eventId;
};

type DraftEventFields = Readonly<{
  source: DiagnosticEventDraft["source"];
  name?: string;
  phase?: string;
  state: DiagnosticEventDraft["state"];
}>;

const validateDraftEventFields = (input: Record<string, unknown>, issues: ValidationIssue[]): DraftEventFields | undefined => {
  if (!checkEnum(input.source, EVENT_SOURCES, "$.source", issues)) return undefined;
  const name = requireString(input, "name", issues);
  if (name !== undefined && (name.length > MAX_EVENT_NAME_LENGTH || !isAllowedDiagnosticEventName(name))) issues.push({ path: "$.name", message: "event name is not in the closed action/event allowlist" });
  const phase = requireString(input, "phase", issues);
  if (phase !== undefined && (!isAllowedPhase(phase) || phase.length > MAX_PHASE_LENGTH)) issues.push({ path: "$.phase", message: "event phase is not allowlisted" });
  if (!checkEnum(input.state, EVENT_STATES, "$.state", issues)) return undefined;
  return { source: input.source as DiagnosticEventDraft["source"], name, phase, state: input.state as DiagnosticEventDraft["state"] };
};

type DraftOptionalFields = Readonly<{
  expectation?: DiagnosticEventExpectation;
  correlation?: DiagnosticEventCorrelation;
  release?: DiagnosticRelease;
  attributes?: DiagnosticEventDraft["attributes"];
}>;

const parseDraftOptionalFields = (input: Record<string, unknown>, issues: ValidationIssue[]): DraftOptionalFields => {
  const expectation = input.expectation === undefined ? undefined : validateExpectation(input.expectation, issues, "$.expectation");
  const correlation = input.correlation === undefined ? undefined : validateCorrelation(input.correlation, issues, "$.correlation");
  const release = input.release === undefined ? undefined : validateRelease(input.release, issues, "$.release");
  const attributeResult = validateDiagnosticAttributes(input.attributes);
  if (!attributeResult.ok) issues.push(...attributeResult.issues);
  const attributes = attributeResult.ok && Object.keys(attributeResult.value).length > 0 ? attributeResult.value : undefined;
  return { expectation, correlation, release, attributes };
};

const buildDraftEvent = (input: Record<string, unknown>, fields: DraftEventFields, optional: DraftOptionalFields, eventId: string, producerSequence: number, occurredAt: string): DiagnosticEventDraft => ({
  version: 1,
  eventId,
  ...(input.producerOperationRef === undefined ? {} : { producerOperationRef: input.producerOperationRef as string }),
  ...(input.parentProducerOperationRef === undefined ? {} : { parentProducerOperationRef: input.parentProducerOperationRef as string }),
  producerSequence,
  occurredAt,
  source: fields.source,
  name: fields.name as string,
  phase: fields.phase as string,
  state: fields.state,
  ...(optional.expectation === undefined ? {} : { expectation: optional.expectation }),
  ...(optional.correlation === undefined ? {} : { correlation: optional.correlation }),
  ...(optional.release === undefined ? {} : { release: optional.release }),
  ...(optional.attributes === undefined ? {} : { attributes: optional.attributes }),
});

const hasRequiredDraftFields = (eventId: string | undefined, producerSequence: unknown, occurredAt: unknown, fields: DraftEventFields): eventId is string => Boolean(eventId && isNonNegativeInteger(producerSequence) && occurredAt && fields.name && fields.phase);

export const validateDiagnosticEventDraft = (input: unknown): ValidationResult<DiagnosticEventDraft> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected an event object" }] };
  pushUnknownKeys(input, DRAFT_KEYS, issues, "$");
  const eventId = validateDraftIdentity(input, issues);
  const producerSequence = input.producerSequence;
  const occurredAt = input.occurredAt;
  const fields = validateDraftEventFields(input, issues);
  if (!fields) return { ok: false, issues };
  const optional = parseDraftOptionalFields(input, issues);
  if (!hasRequiredDraftFields(eventId, producerSequence, occurredAt, fields)) return { ok: false, issues };
  const event = buildDraftEvent(input, fields, optional, eventId, producerSequence as number, occurredAt as string);
  const size = encodedEventSize(event);
  if (size > MAX_DIAGNOSTIC_EVENT_BYTES) issues.push({ path: "$", message: `encoded event is ${size} bytes; maximum is ${MAX_DIAGNOSTIC_EVENT_BYTES}` });
  return finishValidation(event, issues);
};

export const parseDiagnosticEventDraft = (input: unknown): DiagnosticEventDraft => parseOrThrow(validateDiagnosticEventDraft(input), "Invalid DiagnosticEventDraft");
export const validateEventDraft = validateDiagnosticEventDraft;
export const parseEventDraft = parseDiagnosticEventDraft;
export const parseDiagnosticEvent = parseDiagnosticEventDraft;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  return value;
};

export const encodeDiagnosticEvent = (event: DiagnosticEventDraft | AcceptedDiagnosticEvent): string => JSON.stringify(canonicalize(event));
export const encodedEventSize = (event: DiagnosticEventDraft | AcceptedDiagnosticEvent): number => new TextEncoder().encode(encodeDiagnosticEvent(event)).byteLength;
export const isDiagnosticEventWithinLimit = (event: DiagnosticEventDraft | AcceptedDiagnosticEvent): boolean => encodedEventSize(event) <= MAX_DIAGNOSTIC_EVENT_BYTES;
export const assertEventSize = (event: DiagnosticEventDraft | AcceptedDiagnosticEvent): void => {
  const size = encodedEventSize(event);
  if (size > MAX_DIAGNOSTIC_EVENT_BYTES) throw new Error(`Diagnostic event exceeds ${MAX_DIAGNOSTIC_EVENT_BYTES} encoded bytes (${size})`);
};

export const fingerprintDiagnosticEvent = (event: DiagnosticEventDraft | AcceptedDiagnosticEvent): string => {
  return fingerprintCanonicalValue(event);
};

export const fingerprintCanonicalValue = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${digest}`;
};

export const acceptDiagnosticEvent = (input: unknown, context: Readonly<{ diagnosticId: string; cursor: number; receivedAt: string }>): AcceptedDiagnosticEvent => {
  const draft = parseDiagnosticEventDraft(input);
  if (!checkSafeToken(context.diagnosticId, "$.diagnosticId", [], 128)) throw new Error("diagnosticId is not a safe token");
  if (!isNonNegativeInteger(context.cursor)) throw new Error("cursor must be a non-negative integer");
  if (!Number.isFinite(Date.parse(context.receivedAt))) throw new Error("receivedAt must be an ISO date-time");
  const accepted = {
    ...draft,
    diagnosticId: context.diagnosticId,
    cursor: context.cursor,
    receivedAt: context.receivedAt,
    fingerprint: fingerprintDiagnosticEvent(draft),
  } satisfies AcceptedDiagnosticEvent;
  assertEventSize(accepted);
  return accepted;
};

export const validateAcceptedDiagnosticEvent = (input: unknown): ValidationResult<AcceptedDiagnosticEvent> => {
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected an accepted event object" }] };
  const draftInput: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) draftInput[key] = input[key];
  const draftResult = validateDiagnosticEventDraft(draftInput);
  const issues: ValidationIssue[] = draftResult.ok ? [] : [...draftResult.issues];
  pushUnknownKeys(input, ACCEPTED_KEYS, issues, "$");
  const diagnosticId = requireString(input, "diagnosticId", issues);
  if (diagnosticId !== undefined) checkSafeToken(diagnosticId, "$.diagnosticId", issues, 128);
  const cursor = input.cursor;
  if (!isNonNegativeInteger(cursor)) issues.push({ path: "$.cursor", message: "cursor must be a non-negative integer" });
  const receivedAt = input.receivedAt;
  checkDateTime(receivedAt, "$.receivedAt", issues);
  const fingerprint = requireString(input, "fingerprint", issues);
  if (fingerprint !== undefined && !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) issues.push({ path: "$.fingerprint", message: "unsupported event fingerprint" });
  if (!draftResult.ok || !diagnosticId || !isNonNegativeInteger(cursor) || !receivedAt || !fingerprint) return { ok: false, issues };
  const event = { ...draftResult.value, diagnosticId, cursor, receivedAt: receivedAt as string, fingerprint } satisfies AcceptedDiagnosticEvent;
  if (fingerprintDiagnosticEvent(draftResult.value) !== fingerprint) issues.push({ path: "$.fingerprint", message: "fingerprint does not match canonical event" });
  if (encodedEventSize(event) > MAX_DIAGNOSTIC_EVENT_BYTES) issues.push({ path: "$", message: "encoded accepted event exceeds 2 KiB" });
  return finishValidation(event, issues);
};

export const parseAcceptedDiagnosticEvent = (input: unknown): AcceptedDiagnosticEvent => parseOrThrow(validateAcceptedDiagnosticEvent(input), "Invalid accepted DiagnosticEvent");
export const parseAcceptedEvent = parseAcceptedDiagnosticEvent;
export const redactEventAttributes = redactDiagnosticAttributes;
