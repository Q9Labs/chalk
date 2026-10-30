import type { V1EpisodeSnapshot, V1Presence } from "../sync/v1-types";

export function otherDevices(presence: readonly V1Presence[], participantId: string | null): readonly V1Presence[] {
  const identityId = presence.find((item) => item.participantId === participantId)?.identityId;
  return identityId ? presence.filter((item) => item.participantId !== participantId && item.identityId === identityId && item.state === "connected") : [];
}

export function otherDeviceHasMicrophone(snapshot: V1EpisodeSnapshot): boolean {
  const devices = new Set(otherDevices(snapshot.presence?.items ?? [], snapshot.participantId).map((item) => item.participantId));
  return snapshot.media?.items.some((item) => devices.has(item.participantId) && item.source === "microphone" && item.enabled) ?? false;
}
