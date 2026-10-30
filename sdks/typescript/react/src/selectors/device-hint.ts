import type { Participant } from "@q9labsai/chalk-client";

export function deviceHint(participant: Participant | undefined, roster: readonly Participant[]): string | undefined {
  if (!participant?.identityId) return undefined;
  const devices = roster.filter((item) => item.identityId === participant.identityId && item.presence.state === "connected");
  if (devices.length < 2) return undefined;
  const label = participant.deviceType === "phone" ? "Phone" : participant.deviceType === "tablet" ? "Tablet" : participant.deviceType === "computer" ? "Computer" : "Device";
  return `${label} · ${devices.length} devices`;
}
