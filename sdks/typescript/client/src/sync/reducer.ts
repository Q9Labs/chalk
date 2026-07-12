import { compareParticipants } from "./canonical";
import type { CanonicalReplica, ControlEvent, ControlState, PendingCommand, SyncCommand } from "./types";

const textEncoder = new TextEncoder();

export const emptyControlState = (): ControlState => ({ participants: [], status: "active" });

export type ControlReducerError = "invalid_revision" | "revision_gap" | "unknown_participant" | "duplicate_participant" | "invalid_transition" | "invalid_payload" | "ended";

export type ControlReducerResult = { readonly ok: true; readonly state: ControlState; readonly revision: number; readonly stateSchemaVersion: number } | { readonly ok: false; readonly error: ControlReducerError };

export function reduceControlEvent(replica: CanonicalReplica | Pick<CanonicalReplica, "revision" | "stateSchemaVersion" | "state">, event: ControlEvent): ControlReducerResult {
  const error = eventError(replica, event);
  if (error) {
    return { ok: false, error };
  }

  const result = reduceState(replica.state, event);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    state: result.state,
    revision: event.revision,
    stateSchemaVersion: event.stateSchemaVersion,
  };
}

export function optimisticControlState(canonical: ControlState, participantSessionId: string | null, pending: readonly PendingCommand[]): ControlState {
  if (!participantSessionId) {
    return canonical;
  }

  return [...pending].sort(comparePending).reduce((state, command) => applyOptimisticCommand(state, participantSessionId, command.command), canonical);
}

export function isValidControlState(state: ControlState): boolean {
  const candidate = asRecord(state);
  if (!candidate) {
    return false;
  }
  return validControlStateRecord(candidate);
}

function validControlStateRecord(candidate: Record<string, unknown>): boolean {
  const { participants, status } = candidate;
  if (!isControlStatus(status) || !Array.isArray(participants)) {
    return false;
  }
  return status === "ended" ? participants.length === 0 : areValidParticipants(participants);
}

function eventError(replica: CanonicalReplica | Pick<CanonicalReplica, "revision" | "stateSchemaVersion" | "state">, event: ControlEvent): ControlReducerError | null {
  const validationError = eventValidationError(event);
  if (validationError) {
    return validationError;
  }
  return replicaEventError(replica, event);
}

function eventValidationError(event: ControlEvent): ControlReducerError | null {
  if (!isValidEvent(event)) {
    return "invalid_payload";
  }
  return isPositiveInteger(event.stateSchemaVersion) ? null : "invalid_payload";
}

function replicaEventError(replica: Pick<CanonicalReplica, "revision" | "state">, event: ControlEvent): ControlReducerError | null {
  const revisionError = exactNextError(replica.revision, event.baseRevision, event.revision);
  if (revisionError) {
    return revisionError;
  }
  return replica.state.status === "ended" ? "ended" : null;
}

function exactNextError(currentRevision: number, baseRevision: number, revision: number): ControlReducerError | null {
  if (isExactNext(currentRevision, baseRevision, revision)) {
    return null;
  }
  return revision === baseRevision + 1 ? "revision_gap" : "invalid_revision";
}

function areValidParticipants(participants: readonly unknown[]): boolean {
  const participantIds = new Set<string>();
  for (const participant of participants) {
    const participantId = validParticipantId(participant);
    if (!participantId) {
      return false;
    }
    if (participantIds.has(participantId)) {
      return false;
    }
    participantIds.add(participantId);
  }
  return true;
}

export function applyOptimisticCommand(state: ControlState, participantSessionId: string, command: SyncCommand): ControlState {
  if (state.status === "ended") {
    return state;
  }

  const participant = state.participants.find((candidate) => candidate.participantSessionId === participantSessionId);
  if (!participant || participant.handRaised === optimisticHandState(command)) {
    return state;
  }

  return withParticipant(state, { ...participant, handRaised: optimisticHandState(command) });
}

function optimisticHandState(command: SyncCommand): boolean {
  return command.name === "raise_hand";
}

type StateResult = { readonly ok: true; readonly state: ControlState } | { readonly ok: false; readonly error: ControlReducerError };
type StateReducer<Event extends ControlEvent = ControlEvent> = (state: ControlState, event: Event) => StateResult;
type HandEvent = Extract<ControlEvent, { readonly name: "hand_raised" | "hand_lowered" }>;
type StateReducers = {
  readonly participant_joined: StateReducer<Extract<ControlEvent, { readonly name: "participant_joined" }>>;
  readonly participant_left: StateReducer<Extract<ControlEvent, { readonly name: "participant_left" }>>;
  readonly hand_raised: StateReducer<HandEvent>;
  readonly hand_lowered: StateReducer<HandEvent>;
  readonly session_ended: StateReducer<Extract<ControlEvent, { readonly name: "session_ended" }>>;
};

const stateReducers = {
  participant_joined: addParticipant,
  participant_left: (state, event) => removeParticipant(state, event.payload.participantSessionId),
  hand_raised: (state, event) => setHandRaised(state, event.payload.participantSessionId, true),
  hand_lowered: (state, event) => setHandRaised(state, event.payload.participantSessionId, false),
  session_ended: endSession,
} satisfies StateReducers;

function reduceState(state: ControlState, event: ControlEvent): StateResult {
  return stateReducers[event.name](state, event as never);
}

function addParticipant(state: ControlState, event: Extract<ControlEvent, { readonly name: "participant_joined" }>): StateResult {
  const { participantSessionId, displayName } = event.payload;
  if (!isParticipantId(participantSessionId)) {
    return { ok: false, error: "invalid_payload" };
  }
  if (!isDisplayName(displayName)) {
    return { ok: false, error: "invalid_payload" };
  }
  if (state.participants.some((participant) => participant.participantSessionId === participantSessionId)) {
    return { ok: false, error: "duplicate_participant" };
  }
  return { ok: true, state: { ...state, participants: [...state.participants, { participantSessionId, displayName, handRaised: false }].sort(compareParticipants) } };
}

function endSession(): StateResult {
  return { ok: true, state: { status: "ended", participants: [] } };
}

function removeParticipant(state: ControlState, participantSessionId: string): StateResult {
  if (!isParticipantId(participantSessionId)) {
    return { ok: false, error: "invalid_payload" };
  }
  const participants = state.participants.filter((participant) => participant.participantSessionId !== participantSessionId);
  return participants.length === state.participants.length ? { ok: false, error: "unknown_participant" } : { ok: true, state: { ...state, participants } };
}

function setHandRaised(state: ControlState, participantSessionId: string, handRaised: boolean): StateResult {
  if (!isParticipantId(participantSessionId)) {
    return { ok: false, error: "invalid_payload" };
  }
  const participant = state.participants.find((candidate) => candidate.participantSessionId === participantSessionId);
  if (!participant) {
    return { ok: false, error: "unknown_participant" };
  }
  if (participant.handRaised === handRaised) {
    return { ok: false, error: "invalid_transition" };
  }
  return { ok: true, state: withParticipant(state, { ...participant, handRaised }) };
}

function withParticipant(state: ControlState, replacement: ControlState["participants"][number]): ControlState {
  return {
    ...state,
    participants: state.participants.map((participant) => (participant.participantSessionId === replacement.participantSessionId ? replacement : participant)).sort(compareParticipants),
  };
}

function isExactNext(currentRevision: number, baseRevision: number, revision: number): boolean {
  if (![currentRevision, baseRevision, revision].every(isNonNegativeInteger)) {
    return false;
  }
  return baseRevision === currentRevision && revision === baseRevision + 1;
}

function isParticipantId(value: string): boolean {
  return value.length > 0 && textEncoder.encode(value).byteLength <= 256;
}

function isDisplayName(value: string): boolean {
  return textEncoder.encode(value).byteLength <= 256;
}

function isValidEvent(event: ControlEvent): boolean {
  const candidate = asRecord(event);
  if (!candidate) {
    return false;
  }
  return validEventRecord(candidate);
}

function validEventRecord(candidate: Record<string, unknown>): boolean {
  const validators = [hasValidEventIdentity, hasValidEventRevisions, hasExclusiveCorrelationId];
  if (!validators.every((validate) => validate(candidate))) {
    return false;
  }
  return hasValidEventPayload(candidate.name, candidate.payload);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isControlStatus(value: unknown): value is ControlState["status"] {
  return value === "active" || value === "ended";
}

function validParticipantId(value: unknown): string | null {
  const participant = asRecord(value);
  if (!participant) {
    return null;
  }
  const participantId = extractParticipantId(participant);
  if (!participantId) {
    return null;
  }
  return hasValidParticipantDetails(participant) ? participantId : null;
}

function extractParticipantId(participant: Record<string, unknown>): string | null {
  const participantId = participant.participantSessionId;
  if (typeof participantId !== "string") {
    return null;
  }
  return isParticipantId(participantId) ? participantId : null;
}

function hasValidParticipantDetails(participant: Record<string, unknown>): boolean {
  if (typeof participant.displayName !== "string") {
    return false;
  }
  if (!isDisplayName(participant.displayName)) {
    return false;
  }
  return typeof participant.handRaised === "boolean";
}

function hasValidEventIdentity(event: Record<string, unknown>): boolean {
  if (typeof event.eventId !== "string") {
    return false;
  }
  return typeof event.resultingStateDigest === "string";
}

function hasValidEventRevisions(event: Record<string, unknown>): boolean {
  if (typeof event.baseRevision !== "number") {
    return false;
  }
  if (typeof event.revision !== "number") {
    return false;
  }
  return typeof event.stateSchemaVersion === "number";
}

function hasExclusiveCorrelationId(event: Record<string, unknown>): boolean {
  if (event.commandId !== undefined && event.lifecycleIntentId !== undefined) {
    return false;
  }
  return isOptionalString(event.commandId) && isOptionalString(event.lifecycleIntentId);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

const payloadValidators: Record<string, (payload: Record<string, unknown>) => boolean> = {
  participant_joined: isJoinedPayload,
  participant_left: isParticipantPayload,
  hand_raised: isParticipantPayload,
  hand_lowered: isParticipantPayload,
  session_ended: isEmptyPayload,
};

function hasValidEventPayload(name: unknown, value: unknown): boolean {
  const payload = asRecord(value);
  if (!payload || typeof name !== "string") {
    return false;
  }
  return validateKnownPayload(name, payload);
}

function validateKnownPayload(name: string, payload: Record<string, unknown>): boolean {
  const validate = payloadValidators[name];
  return validate ? validate(payload) : false;
}

function isJoinedPayload(payload: Record<string, unknown>): boolean {
  return typeof payload.participantSessionId === "string" && typeof payload.displayName === "string";
}

function isParticipantPayload(payload: Record<string, unknown>): boolean {
  return typeof payload.participantSessionId === "string";
}

function isEmptyPayload(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).length === 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function comparePending(left: PendingCommand, right: PendingCommand): number {
  return left.createdAt - right.createdAt || (left.commandId < right.commandId ? -1 : left.commandId > right.commandId ? 1 : 0);
}
