import type { ParticipantState } from "../internal/core";

type RoomParticipant = ParticipantState["participants"][number];

export function pickStageParticipant(sharerParticipantId: string | null, remoteParticipants: readonly RoomParticipant[], localParticipant: RoomParticipant | null, activeSpeaker: RoomParticipant | null): RoomParticipant | null {
  if (sharerParticipantId) {
    return remoteParticipants.find((participant) => participant.id === sharerParticipantId) ?? localParticipant;
  }

  return activeSpeaker ?? remoteParticipants.find((participant) => participant.videoTrack) ?? remoteParticipants[0] ?? localParticipant;
}
