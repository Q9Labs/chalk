import type { Participant } from "./types";
import type { V1EpisodeSnapshot } from "../sync/v1-types";

type PersonSeat = Pick<Participant, "participantId" | "identityId">;
export function otherDevices<Seat extends PersonSeat>(participants: readonly Seat[], participantId: string | null, ownIdentityId?: string): readonly Seat[] {
  const identityId = ownIdentityId ?? participants.find((item) => item.participantId === participantId)?.identityId;
  return identityId ? participants.filter((item) => item.participantId !== participantId && item.identityId === identityId) : [];
}

export function otherDeviceHasMicrophone(snapshot: V1EpisodeSnapshot, participants: readonly PersonSeat[]): boolean {
  if (snapshot.control?.status === "ended") return false;
  const admitted = snapshot.control ? new Set(snapshot.control.participants.map((item) => item.participantId)) : null;
  const devices = new Set(
    otherDevices(participants, snapshot.participantId, snapshot.participantIdentityId)
      .filter((item) => !admitted || admitted.has(item.participantId))
      .map((item) => item.participantId),
  );
  return snapshot.media?.items.some((item) => devices.has(item.participantId) && item.source === "microphone" && item.enabled) ?? false;
}
