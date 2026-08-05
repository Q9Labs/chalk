import type { SpaceParticipant } from "./types";

export function nativeSpaceGridKey(prefix: string, participants: readonly SpaceParticipant[]): string {
  const participantIds = participants.map((participant) => participant.id).join("|");
  return `${prefix}-${participantIds || "empty"}`;
}
