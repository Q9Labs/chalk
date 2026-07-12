import type { RoomParticipant } from "./types";

export function nativeMeetingGridKey(prefix: string, participants: readonly RoomParticipant[]): string {
  const participantIds = participants.map((participant) => participant.id).join("|");
  return `${prefix}-${participantIds || "empty"}`;
}
