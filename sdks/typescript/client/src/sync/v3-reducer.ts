import { SnapshotSchema, type SyncV3ServerFrame } from "../generated/sync-v3";
import { canonicalJsonBytesFromUnknown } from "./canonical";
import type { V3AdmissionRequest, V3ControlState, V3Participant, V3Role, V3TargetCommand } from "./v3-types";

type EventFrame = Extract<SyncV3ServerFrame, { readonly type: "event" }>;
type Snapshot = typeof SnapshotSchema.Type;

const encoder = new TextEncoder();
const digestPrefix = encoder.encode("chalk-sync-state-v3");

export class V3ReplicaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V3ReplicaError";
  }
}

export async function restoreV3Snapshot(snapshot: Snapshot): Promise<V3ControlState> {
  const state = snapshotToState(snapshot);
  assertV3ControlSemantics(state);
  await assertDigest(state);
  return state;
}

export async function applyV3Event(state: V3ControlState, event: EventFrame): Promise<V3ControlState> {
  if (event.revision <= state.revision) throw new V3ReplicaError("duplicate control event requires retained client evidence");
  if (state.status === "ended") throw new V3ReplicaError("ended control state cannot advance");
  if (event.base_revision !== state.revision || event.revision !== state.revision + 1) throw new V3ReplicaError("control event is not exact-next");
  if (event.schema_version !== state.stateSchemaVersion) throw new V3ReplicaError("control event schema version changed");

  const next = reduceEvent(state, event);
  const candidate = { ...next, revision: event.revision, stateDigest: event.resulting_state_digest };
  assertV3ControlSemantics(candidate);
  await assertDigest(candidate);
  return candidate;
}

export function optimisticV3Control(state: V3ControlState, actorId: string, commands: readonly V3TargetCommand[]): V3ControlState {
  return commands.reduce((current, command) => applyOptimistic(current, actorId, command), state);
}

export function snapshotToState(snapshot: Snapshot): V3ControlState {
  if (snapshot.host_participant_session_id === null && (snapshot.status !== "active" || snapshot.participants.length !== 0)) {
    throw new V3ReplicaError("nullable host is valid only before the first admission");
  }
  const roleCapabilities = {
    host: [...snapshot.role_capabilities.host],
    cohost: [...snapshot.role_capabilities.cohost],
    participant: [...snapshot.role_capabilities.participant],
  };
  for (const participant of snapshot.participants) {
    if (!sameStrings(participant.capabilities, roleCapabilities[participant.role])) throw new V3ReplicaError("participant capabilities do not match the durable role map");
  }
  return {
    revision: snapshot.control_revision,
    stateSchemaVersion: snapshot.state_schema_version,
    stateDigest: snapshot.state_digest,
    status: snapshot.status,
    admissionPolicy: snapshot.admission_policy,
    hostExitPolicy: snapshot.host_exit_policy,
    hostParticipantSessionId: snapshot.host_participant_session_id,
    deadlineAtMs: snapshot.deadline_at_ms,
    deadlineGeneration: snapshot.deadline_generation,
    roleCapabilities,
    recording: snapshot.recording && { recordingId: snapshot.recording.recording_id, status: snapshot.recording.status, failureCode: snapshot.recording.failure_code },
    participants: snapshot.participants.map((participant) => ({
      participantSessionId: participant.participant_session_id,
      displayName: participant.display_name,
      handRaised: participant.hand_raised,
      admissionRevision: participant.admission_revision,
      role: participant.role,
      eligibleRoles: [...participant.eligible_roles],
      capabilities: [...roleCapabilities[participant.role]],
    })),
    admissionRequests: snapshot.admission_requests.map((request) => ({
      admissionRequestId: request.admission_request_id,
      participantSessionId: request.participant_session_id,
      displayName: request.display_name,
      initialRole: request.initial_role,
      eligibleRoles: [...request.eligible_roles],
      expiresAtMs: request.expires_at_ms,
    })),
  };
}

export function assertV3ControlSemantics(state: V3ControlState): void {
  const participantIds = new Set<string>();
  let hosts = 0;
  for (const participant of state.participants) {
    if (participantIds.has(participant.participantSessionId)) throw new V3ReplicaError("duplicate participant ID");
    participantIds.add(participant.participantSessionId);
    assertEligibleRoles(participant.eligibleRoles);
    if (!participant.eligibleRoles.includes(participant.role)) throw new V3ReplicaError("participant role is not eligible");
    if (participant.role === "host") {
      hosts += 1;
      if (!participant.eligibleRoles.includes("cohost")) throw new V3ReplicaError("host must remain eligible for cohost");
      if (participant.participantSessionId !== state.hostParticipantSessionId) throw new V3ReplicaError("host role does not match host authority");
    }
    if (!sameStrings(participant.capabilities, state.roleCapabilities[participant.role])) throw new V3ReplicaError("participant capabilities do not match the durable role map");
    if (participant.displayName !== participant.displayName.trim() || participant.displayName.length === 0) throw new V3ReplicaError("participant display name has surrounding whitespace");
  }
  if (state.status === "ended" && (state.participants.length !== 0 || state.hostParticipantSessionId !== null || state.admissionRequests.length !== 0 || state.recording !== null)) {
    throw new V3ReplicaError("ended control state retains active Session state");
  }
  if (state.status === "active" && state.participants.length > 0 && (hosts !== 1 || state.hostParticipantSessionId === null)) throw new V3ReplicaError("active control state must have exactly one host");
  if (state.status === "active" && state.participants.length === 0 && state.hostParticipantSessionId !== null) throw new V3ReplicaError("empty pre-admission state cannot name a host");

  const requestIds = new Set<string>();
  const pendingParticipantIds = new Set<string>();
  for (const request of state.admissionRequests) {
    if (requestIds.has(request.admissionRequestId)) throw new V3ReplicaError("duplicate admission request ID");
    if (pendingParticipantIds.has(request.participantSessionId) || participantIds.has(request.participantSessionId)) throw new V3ReplicaError("active and pending participant IDs overlap");
    requestIds.add(request.admissionRequestId);
    pendingParticipantIds.add(request.participantSessionId);
    assertEligibleRoles(request.eligibleRoles);
    if (!request.eligibleRoles.includes(request.initialRole)) throw new V3ReplicaError("initial role is not eligible");
    if (request.initialRole === "host" && !request.eligibleRoles.includes("cohost")) throw new V3ReplicaError("pending host must remain eligible for cohost");
    if (request.displayName !== request.displayName.trim() || request.displayName.length === 0) throw new V3ReplicaError("admission display name has surrounding whitespace");
  }

  if (state.recording?.status === "failed" ? state.recording.failureCode === null : state.recording?.failureCode !== null && state.recording !== null) {
    throw new V3ReplicaError("recording failure code does not match its status");
  }
}

export async function computeV3StateDigest(state: V3ControlState): Promise<string> {
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, state.stateSchemaVersion, false);
  const bytes = joinBytes(digestPrefix, version, canonicalJsonBytesFromUnknown(durableProjection(state)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function durableProjection(state: V3ControlState): unknown {
  return {
    admission_policy: state.admissionPolicy,
    admission_requests: state.admissionRequests.map((request) => ({
      admission_request_id: request.admissionRequestId,
      display_name: request.displayName,
      eligible_roles: request.eligibleRoles,
      expires_at_ms: request.expiresAtMs,
      initial_role: request.initialRole,
      participant_session_id: request.participantSessionId,
    })),
    control_revision: state.revision,
    deadline_at_ms: state.deadlineAtMs,
    deadline_generation: state.deadlineGeneration,
    host_exit_policy: state.hostExitPolicy,
    host_participant_session_id: state.hostParticipantSessionId,
    participants: [...state.participants]
      .sort((left, right) => left.participantSessionId.localeCompare(right.participantSessionId))
      .map((participant) => ({
        admission_revision: participant.admissionRevision,
        capabilities: state.roleCapabilities[participant.role],
        display_name: participant.displayName,
        eligible_roles: participant.eligibleRoles,
        hand_raised: participant.handRaised,
        participant_session_id: participant.participantSessionId,
        role: participant.role,
      })),
    recording: state.recording && { failure_code: state.recording.failureCode, recording_id: state.recording.recordingId, status: state.recording.status },
    role_capabilities: state.roleCapabilities,
    state_schema_version: state.stateSchemaVersion,
    status: state.status,
  };
}

async function assertDigest(state: V3ControlState): Promise<void> {
  if ((await computeV3StateDigest(state)) !== state.stateDigest) throw new V3ReplicaError("control state digest mismatch");
}

function reduceEvent(state: V3ControlState, event: EventFrame): V3ControlState {
  switch (event.name) {
    case "participant_joined": {
      if (state.participants.some((participant) => participant.participantSessionId === event.payload.participant_session_id)) throw new V3ReplicaError("duplicate participant join");
      const participant = participantFromJoin(state, event.payload);
      return {
        ...state,
        hostParticipantSessionId: participant.role === "host" && state.hostParticipantSessionId === null ? participant.participantSessionId : state.hostParticipantSessionId,
        participants: [...state.participants, participant],
        admissionRequests: state.admissionRequests.filter((request) => request.participantSessionId !== participant.participantSessionId),
      };
    }
    case "participant_left":
      return removeParticipant(state, event.payload.participant_session_id);
    case "host_left_and_transferred":
      const withoutDepartingHost = removeParticipant(state, event.payload.departing_participant_session_id);
      return {
        ...withoutDepartingHost,
        hostParticipantSessionId: event.payload.successor_participant_session_id,
        participants: withoutDepartingHost.participants.map((participant) => withDerivedRole(state, participant, participant.participantSessionId === event.payload.successor_participant_session_id ? "host" : participant.role)),
      };
    case "session_ended":
      return { ...state, status: "ended", participants: [], admissionRequests: [], hostParticipantSessionId: null, recording: null };
    case "hand_raised":
    case "hand_lowered":
      return updateParticipant(state, event.payload.participant_session_id, (participant) => ({ ...participant, handRaised: event.name === "hand_raised" }));
    case "participant_display_name_changed":
      return updateParticipant(state, event.payload.participant_session_id, (participant) => ({ ...participant, displayName: event.payload.display_name }));
    case "admission_policy_changed":
      return { ...state, admissionPolicy: event.payload.policy };
    case "participant_role_changed":
      return updateParticipant(state, event.payload.participant_session_id, (participant) => withDerivedRole(state, participant, event.payload.role));
    case "host_transferred":
      return {
        ...state,
        hostParticipantSessionId: event.payload.new_host_participant_session_id,
        participants: state.participants.map((participant) =>
          withDerivedRole(state, participant, participant.participantSessionId === event.payload.new_host_participant_session_id ? "host" : participant.participantSessionId === event.payload.previous_host_participant_session_id ? "cohost" : participant.role),
        ),
      };
    case "admission_requested":
      return { ...state, admissionRequests: [...state.admissionRequests, admissionRequestFromEvent(event.payload)] };
    case "admission_denied":
    case "admission_expired":
      return removeAdmissionRequest(state, event.payload.admission_request_id);
    case "recording_status_changed":
      return transitionRecording(state, event.payload);
    case "deadline_changed":
      if (event.payload.deadline_generation !== state.deadlineGeneration + 1) throw new V3ReplicaError("deadline generation is not exact-next");
      return { ...state, deadlineAtMs: event.payload.deadline_at_ms, deadlineGeneration: event.payload.deadline_generation };
    case "participant_microphone_stopped":
    case "participant_camera_stopped":
    case "participant_screen_share_stopped":
      requireParticipant(state, event.payload.participant_session_id);
      return state;
  }
}

function applyOptimistic(state: V3ControlState, actorId: string, command: V3TargetCommand): V3ControlState {
  switch (command.name) {
    case "set_hand_raised":
      return updateParticipant(state, actorId, (participant) => ({ ...participant, handRaised: command.payload.raised }), false);
    case "set_display_name":
      return updateParticipant(state, actorId, (participant) => ({ ...participant, displayName: command.payload.display_name }), false);
    case "set_admission_policy":
      return { ...state, admissionPolicy: command.payload.policy };
    case "set_participant_role":
      return updateParticipant(state, command.payload.participant_session_id, (participant) => withDerivedRole(state, participant, command.payload.role), false);
    case "transfer_host":
      return {
        ...state,
        hostParticipantSessionId: command.payload.participant_session_id,
        participants: state.participants.map((participant) => withDerivedRole(state, participant, participant.participantSessionId === command.payload.participant_session_id ? "host" : participant.participantSessionId === state.hostParticipantSessionId ? "cohost" : participant.role)),
      };
  }
}

function participantFromJoin(state: V3ControlState, payload: Extract<EventFrame, { readonly name: "participant_joined" }>["payload"]): V3Participant {
  return {
    participantSessionId: payload.participant_session_id,
    displayName: payload.display_name,
    handRaised: false,
    admissionRevision: payload.admission_revision,
    role: payload.role,
    eligibleRoles: [...payload.eligible_roles],
    capabilities: [...state.roleCapabilities[payload.role]],
  };
}

function admissionRequestFromEvent(payload: Extract<EventFrame, { readonly name: "admission_requested" }>["payload"]): V3AdmissionRequest {
  return {
    admissionRequestId: payload.admission_request_id,
    participantSessionId: payload.participant_session_id,
    displayName: payload.display_name,
    initialRole: payload.initial_role,
    eligibleRoles: [...payload.eligible_roles],
    expiresAtMs: payload.expires_at_ms,
  };
}

function withDerivedRole(state: V3ControlState, participant: V3Participant, role: V3Role): V3Participant {
  return { ...participant, role, capabilities: [...state.roleCapabilities[role]] };
}

function updateParticipant(state: V3ControlState, participantId: string, update: (participant: V3Participant) => V3Participant, required = true): V3ControlState {
  let found = false;
  const participants = state.participants.map((participant) => {
    if (participant.participantSessionId !== participantId) return participant;
    found = true;
    return update(participant);
  });
  if (required && !found) throw new V3ReplicaError("control event references an unknown participant");
  return found ? { ...state, participants } : state;
}

function removeParticipant(state: V3ControlState, participantId: string): V3ControlState {
  const participants = state.participants.filter((participant) => participant.participantSessionId !== participantId);
  if (participants.length === state.participants.length) throw new V3ReplicaError("control event references an unknown participant");
  return { ...state, participants };
}

function requireParticipant(state: V3ControlState, participantId: string): V3Participant {
  const participant = state.participants.find((candidate) => candidate.participantSessionId === participantId);
  if (!participant) throw new V3ReplicaError("control event references an unknown participant");
  return participant;
}

function removeAdmissionRequest(state: V3ControlState, admissionRequestId: string): V3ControlState {
  const admissionRequests = state.admissionRequests.filter((request) => request.admissionRequestId !== admissionRequestId);
  if (admissionRequests.length === state.admissionRequests.length) throw new V3ReplicaError("control event references an unknown admission request");
  return { ...state, admissionRequests };
}

type RecordingEventPayload = Extract<EventFrame, { readonly name: "recording_status_changed" }>["payload"];

function transitionRecording(state: V3ControlState, payload: RecordingEventPayload): V3ControlState {
  const current = state.recording;
  if (payload.status === "starting") {
    if (current !== null && current.status !== "stopped" && current.status !== "failed") throw new V3ReplicaError("Recording is already active");
    return { ...state, recording: recordingFromPayload(payload) };
  }
  if (!current || current.recordingId !== payload.recording_id) throw new V3ReplicaError("Recording transition changed identity");
  const allowed =
    (current.status === "starting" && (payload.status === "recording" || payload.status === "failed")) ||
    (current.status === "recording" && (payload.status === "stopping" || payload.status === "failed")) ||
    (current.status === "stopping" && (payload.status === "stopped" || payload.status === "failed"));
  if (!allowed) throw new V3ReplicaError("illegal Recording status transition");
  return { ...state, recording: recordingFromPayload(payload) };
}

function recordingFromPayload(payload: RecordingEventPayload): NonNullable<V3ControlState["recording"]> {
  return { recordingId: payload.recording_id, status: payload.status, failureCode: payload.failure_code };
}

function joinBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function assertEligibleRoles(roles: readonly V3Role[]): void {
  if (roles.length === 0 || new Set(roles).size !== roles.length) throw new V3ReplicaError("eligible roles must be non-empty and unique");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
