import type { IncomingMediaRequest, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { PreviewClientCommand } from "./preview-client";

/** The commands that act on other participants: roles, their media, requests to them, the door and removal. */
export type PreviewRosterCommand = Extract<PreviewClientCommand, { readonly type: "assignRole" | "mute" | "stopVideo" | "stopScreenShare" | "requestMedia" | "remove" | "admit" | "deny" | "setAdmissionPolicy" }>;

export function applyRosterCommand(snapshot: SpaceSnapshot, command: PreviewRosterCommand): SpaceSnapshot {
  switch (command.type) {
    case "assignRole":
      return {
        ...snapshot,
        participants: {
          ...snapshot.participants,
          roster: snapshot.participants.roster.map((participant) => (participant.participantId === command.participantId ? { ...participant, role: command.roleName } : participant)),
        },
      };
    case "mute":
      return updateParticipantMedia(snapshot, command.participantId, "microphone", "inactive");
    case "stopVideo":
      return updateParticipantMedia(snapshot, command.participantId, "camera", "inactive");
    case "stopScreenShare":
      return updateParticipantMedia(snapshot, command.participantId, "screenShare", "inactive");
    case "requestMedia":
      return addIncomingRequest(snapshot, command);
    case "remove":
      return { ...snapshot, participants: { ...snapshot.participants, roster: snapshot.participants.roster.filter((participant) => participant.participantId !== command.participantId) } };
    case "admit":
    case "deny":
      return { ...snapshot, participants: { ...snapshot.participants, admissionQueue: snapshot.participants.admissionQueue.filter((request) => request.requestId !== command.requestId) } };
    case "setAdmissionPolicy":
      return { ...snapshot, participants: { ...snapshot.participants, admissionPolicy: command.policy } };
  }
}

function updateParticipantMedia(snapshot: SpaceSnapshot, participantId: string, source: "microphone" | "camera" | "screenShare", state: "inactive"): SpaceSnapshot {
  return {
    ...snapshot,
    participants: {
      ...snapshot.participants,
      roster: snapshot.participants.roster.map((participant) => (participant.participantId === participantId ? { ...participant, media: { ...participant.media, [source]: state } } : participant)),
    },
  };
}

function addIncomingRequest(snapshot: SpaceSnapshot, command: Extract<PreviewClientCommand, { readonly type: "requestMedia" }>): SpaceSnapshot {
  const participant = snapshot.participants.roster.find((candidate) => candidate.participantId === command.participantId);
  const request: IncomingMediaRequest = {
    requestId: command.requestId,
    kind: command.kind === "microphone" ? "unmute" : "start_camera",
    actorParticipantId: command.participantId,
    actorDisplayName: participant?.displayName ?? null,
    expiresAt: "2026-08-01T10:20:00.000Z",
  };
  return { ...snapshot, media: { ...snapshot.media, incomingRequests: [...snapshot.media.incomingRequests, request] } };
}
