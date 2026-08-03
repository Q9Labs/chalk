import { SnapshotSchema, type SyncV1ServerFrame } from "../generated/sync";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJsonBytesFromUnknown } from "./canonical";
import type { V1AdmissionRequest, V1ControlState, V1Participant, V1Role, V1TargetCommand } from "./v1-types";

type EventFrame = Extract<SyncV1ServerFrame, { readonly type: "event" }>;
type Snapshot = typeof SnapshotSchema.Type;

const encoder = new TextEncoder();
const digestPrefix = encoder.encode("chalk-sync-state-v1");

export class V1ReplicaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V1ReplicaError";
  }
}

export async function restoreV1Snapshot(snapshot: Snapshot): Promise<V1ControlState> {
  const state = snapshotToState(snapshot);
  assertV1ControlSemantics(state);
  await assertDigest(state);
  return state;
}

export async function applyV1Event(state: V1ControlState, event: EventFrame): Promise<V1ControlState> {
  if (event.revision <= state.revision) throw new V1ReplicaError("duplicate control event requires retained client evidence");
  if (state.status === "ended") throw new V1ReplicaError("ended control state cannot advance");
  if (event.base_revision !== state.revision || event.revision !== state.revision + 1) throw new V1ReplicaError("control event is not exact-next");
  if (event.schema_version !== state.stateSchemaVersion) throw new V1ReplicaError("control event schema version changed");

  const next = reduceEvent(state, event);
  const candidate = { ...next, revision: event.revision, stateDigest: event.resulting_state_digest };
  assertV1ControlSemantics(candidate);
  await assertDigest(candidate);
  return candidate;
}

export function optimisticV1Control(state: V1ControlState, actorId: string, commands: readonly V1TargetCommand[]): V1ControlState {
  return commands.reduce((current, command) => applyOptimistic(current, actorId, command), state);
}

export function snapshotToState(snapshot: Snapshot): V1ControlState {
  const roleCapabilities = Object.fromEntries(Object.entries(snapshot.role_capabilities).map(([role, capabilities]) => [role, [...capabilities]])) as Readonly<Record<string, V1ControlState["roleCapabilities"][string]>>;
  return {
    revision: snapshot.control_revision,
    stateSchemaVersion: snapshot.state_schema_version,
    stateDigest: snapshot.state_digest,
    status: snapshot.status,
    admissionPolicy: snapshot.admission_policy,
    // Kept as an internal compatibility alias until the SpaceClient wave.
    hostExitPolicy: "require_transfer",
    hostParticipantSessionId: null,
    deadlineAtMs: snapshot.deadline_at_ms,
    deadlineGeneration: snapshot.deadline_generation,
    roleCapabilities,
    recording: snapshot.recording && { recordingId: snapshot.recording.recording_id, status: snapshot.recording.status, failureCode: snapshot.recording.failure_code },
    participants: snapshot.participants.map((participant) => ({
      participantSessionId: participant.participant_id,
      displayName: participant.display_name,
      handRaised: participant.hand_raised,
      admissionRevision: participant.admission_revision,
      role: participant.role,
      // The canonical wire contract carries one requested/assigned role. Keep
      // the former list-shaped alias for consumers that still render it.
      eligibleRoles: [participant.role],
      capabilities: [...participant.capabilities],
    })),
    admissionRequests: snapshot.admission_requests.map((request) => ({
      admissionRequestId: request.admission_request_id,
      participantSessionId: request.participant_id,
      displayName: request.display_name,
      initialRole: request.role,
      eligibleRoles: [request.role],
      expiresAtMs: request.expires_at_ms,
    })),
  };
}

export function assertV1ControlSemantics(state: V1ControlState): void {
  const participantIds = new Set<string>();
  for (const participant of state.participants) {
    if (participantIds.has(participant.participantSessionId)) throw new V1ReplicaError("duplicate participant ID");
    participantIds.add(participant.participantSessionId);
    const capabilities = state.roleCapabilities[participant.role];
    if (!capabilities) throw new V1ReplicaError("participant role has no capability bundle");
    if (!sameStrings(participant.capabilities, capabilities)) throw new V1ReplicaError("participant capabilities do not match the durable role map");
    if (participant.displayName !== participant.displayName.trim() || participant.displayName.length === 0) throw new V1ReplicaError("participant display name has surrounding whitespace");
  }
  // Legacy callers may still populate the former host authority alias. It is
  // not part of the canonical Episode snapshot, but when present it must not
  // silently disagree with the role projection.
  if (state.hostParticipantSessionId !== null) {
    const hosts = state.participants.filter((participant) => participant.role === "host");
    if (hosts.length !== 1 || hosts[0]?.participantSessionId !== state.hostParticipantSessionId) throw new V1ReplicaError("host authority does not match role projection");
  }
  if (state.status === "ended" && (state.participants.length !== 0 || state.admissionRequests.length !== 0 || state.recording !== null)) {
    throw new V1ReplicaError("ended control state retains active Episode state");
  }

  const requestIds = new Set<string>();
  const pendingParticipantIds = new Set<string>();
  for (const request of state.admissionRequests) {
    if (requestIds.has(request.admissionRequestId)) throw new V1ReplicaError("duplicate admission request ID");
    if (pendingParticipantIds.has(request.participantSessionId) || participantIds.has(request.participantSessionId)) throw new V1ReplicaError("active and pending participant IDs overlap");
    requestIds.add(request.admissionRequestId);
    pendingParticipantIds.add(request.participantSessionId);
    if (request.displayName !== request.displayName.trim() || request.displayName.length === 0) throw new V1ReplicaError("admission display name has surrounding whitespace");
  }

  if (state.recording?.status === "failed" ? state.recording.failureCode === null : state.recording?.failureCode !== null && state.recording !== null) {
    throw new V1ReplicaError("recording failure code does not match its status");
  }
}

export async function computeV1StateDigest(state: V1ControlState): Promise<string> {
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, state.stateSchemaVersion, false);
  const bytes = joinBytes(digestPrefix, version, canonicalJsonBytesFromUnknown(durableProjection(state)));
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function durableProjection(state: V1ControlState): unknown {
  return {
    admission_policy: state.admissionPolicy,
    admission_requests: state.admissionRequests.map((request) => ({
      admission_request_id: request.admissionRequestId,
      display_name: request.displayName,
      expires_at_ms: request.expiresAtMs,
      participant_id: request.participantSessionId,
      role: request.initialRole,
    })),
    control_revision: state.revision,
    deadline_at_ms: state.deadlineAtMs,
    deadline_generation: state.deadlineGeneration,
    participants: [...state.participants]
      .sort((left, right) => left.participantSessionId.localeCompare(right.participantSessionId))
      .map((participant) => ({
        admission_revision: participant.admissionRevision,
        capabilities: state.roleCapabilities[participant.role],
        display_name: participant.displayName,
        hand_raised: participant.handRaised,
        participant_id: participant.participantSessionId,
        role: participant.role,
      })),
    recording: state.recording && { failure_code: state.recording.failureCode, recording_id: state.recording.recordingId, status: state.recording.status },
    role_capabilities: state.roleCapabilities,
    state_schema_version: state.stateSchemaVersion,
    status: state.status,
  };
}

async function assertDigest(state: V1ControlState): Promise<void> {
  if ((await computeV1StateDigest(state)) !== state.stateDigest) throw new V1ReplicaError("control state digest mismatch");
}

function reduceEvent(state: V1ControlState, event: EventFrame): V1ControlState {
  switch (event.name) {
    case "participant_joined": {
      if (state.participants.some((participant) => participant.participantSessionId === event.payload.participant_id)) throw new V1ReplicaError("duplicate participant join");
      const participant = participantFromJoin(state, event.payload);
      return {
        ...state,
        participants: [...state.participants, participant],
        admissionRequests: state.admissionRequests.filter((request) => request.participantSessionId !== participant.participantSessionId),
      };
    }
    case "participant_left":
      return removeParticipant(state, event.payload.participant_id);
    case "episode_started":
      return state;
    case "episode_ended":
      return { ...state, status: "ended", participants: [], admissionRequests: [], recording: null };
    case "hand_raised":
    case "hand_lowered":
      return updateParticipant(state, event.payload.participant_id, (participant) => ({ ...participant, handRaised: event.name === "hand_raised" }));
    case "participant_display_name_changed":
      return updateParticipant(state, event.payload.participant_id, (participant) => ({ ...participant, displayName: event.payload.display_name }));
    case "admission_policy_changed":
      return { ...state, admissionPolicy: event.payload.policy };
    case "role_assigned":
      return updateParticipant(state, event.payload.participant_id, (participant) => withDerivedRole(state, participant, event.payload.role));
    case "admission_requested":
      return { ...state, admissionRequests: [...state.admissionRequests, admissionRequestFromEvent(event.payload)] };
    case "admission_denied":
    case "admission_expired":
      return removeAdmissionRequest(state, event.payload.admission_request_id);
    case "recording_status_changed":
      return transitionRecording(state, event.payload);
    case "deadline_changed":
      if (event.payload.deadline_generation !== state.deadlineGeneration + 1) throw new V1ReplicaError("deadline generation is not exact-next");
      return { ...state, deadlineAtMs: event.payload.deadline_at_ms, deadlineGeneration: event.payload.deadline_generation };
    case "participant_microphone_stopped":
    case "participant_camera_stopped":
    case "participant_screen_share_stopped":
      requireParticipant(state, event.payload.participant_id);
      return state;
  }
}

function applyOptimistic(state: V1ControlState, actorId: string, command: V1TargetCommand): V1ControlState {
  switch (command.name) {
    case "set_hand_raised":
      return updateParticipant(state, actorId, (participant) => ({ ...participant, handRaised: command.payload.raised }), false);
    case "set_display_name":
      return updateParticipant(state, actorId, (participant) => ({ ...participant, displayName: command.payload.display_name }), false);
    case "set_admission_policy":
      return { ...state, admissionPolicy: command.payload.policy };
    case "assign_roles":
      return updateParticipant(state, command.payload.participant_id, (participant) => withDerivedRole(state, participant, command.payload.role), false);
  }
}

function participantFromJoin(state: V1ControlState, payload: Extract<EventFrame, { readonly name: "participant_joined" }>["payload"]): V1Participant {
  const capabilities = state.roleCapabilities[payload.role];
  if (!capabilities) throw new V1ReplicaError("participant join references an unknown role");

  return {
    participantSessionId: payload.participant_id,
    displayName: payload.display_name,
    handRaised: false,
    admissionRevision: payload.admission_revision,
    role: payload.role,
    eligibleRoles: [payload.role],
    capabilities: [...capabilities],
  };
}

function admissionRequestFromEvent(payload: Extract<EventFrame, { readonly name: "admission_requested" }>["payload"]): V1AdmissionRequest {
  return {
    admissionRequestId: payload.admission_request_id,
    participantSessionId: payload.participant_id,
    displayName: payload.display_name,
    initialRole: payload.role,
    eligibleRoles: [payload.role],
    expiresAtMs: payload.expires_at_ms,
  };
}

function withDerivedRole(state: V1ControlState, participant: V1Participant, role: V1Role): V1Participant {
  const capabilities = state.roleCapabilities[role];
  if (!capabilities) throw new V1ReplicaError("role assignment references an unknown role");
  return { ...participant, role, capabilities: [...capabilities] };
}

function updateParticipant(state: V1ControlState, participantId: string, update: (participant: V1Participant) => V1Participant, required = true): V1ControlState {
  let found = false;
  const participants = state.participants.map((participant) => {
    if (participant.participantSessionId !== participantId) return participant;
    found = true;
    return update(participant);
  });
  if (required && !found) throw new V1ReplicaError("control event references an unknown participant");
  return found ? { ...state, participants } : state;
}

function removeParticipant(state: V1ControlState, participantId: string): V1ControlState {
  const participants = state.participants.filter((participant) => participant.participantSessionId !== participantId);
  if (participants.length === state.participants.length) throw new V1ReplicaError("control event references an unknown participant");
  return { ...state, participants };
}

function requireParticipant(state: V1ControlState, participantId: string): V1Participant {
  const participant = state.participants.find((candidate) => candidate.participantSessionId === participantId);
  if (!participant) throw new V1ReplicaError("control event references an unknown participant");
  return participant;
}

function removeAdmissionRequest(state: V1ControlState, admissionRequestId: string): V1ControlState {
  const admissionRequests = state.admissionRequests.filter((request) => request.admissionRequestId !== admissionRequestId);
  if (admissionRequests.length === state.admissionRequests.length) throw new V1ReplicaError("control event references an unknown admission request");
  return { ...state, admissionRequests };
}

type RecordingEventPayload = Extract<EventFrame, { readonly name: "recording_status_changed" }>["payload"];

function transitionRecording(state: V1ControlState, payload: RecordingEventPayload): V1ControlState {
  const current = state.recording;
  if (payload.status === "starting") {
    if (current !== null && current.status !== "stopped" && current.status !== "failed") throw new V1ReplicaError("Recording is already active");
    return { ...state, recording: recordingFromPayload(payload) };
  }
  if (!current || current.recordingId !== payload.recording_id) throw new V1ReplicaError("Recording transition changed identity");
  const allowed =
    (current.status === "starting" && (payload.status === "recording" || payload.status === "failed")) ||
    (current.status === "recording" && (payload.status === "stopping" || payload.status === "failed")) ||
    (current.status === "stopping" && (payload.status === "stopped" || payload.status === "failed"));
  if (!allowed) throw new V1ReplicaError("illegal Recording status transition");
  return { ...state, recording: recordingFromPayload(payload) };
}

function recordingFromPayload(payload: RecordingEventPayload): NonNullable<V1ControlState["recording"]> {
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
