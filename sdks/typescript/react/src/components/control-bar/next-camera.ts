import type { MediaDevice } from "./control-bar-behavior";

function facing(label: string) {
  if (/\b(front|user|facetime)\b/i.test(label)) return "user";
  if (/\b(back|rear|environment)\b/i.test(label)) return "environment";
  return undefined;
}

export function nextCamera(devices: readonly MediaDevice[], selectedId?: string, track?: Pick<MediaStreamTrack, "getSettings" | "getCapabilities"> | null): MediaDevice | undefined {
  const settings = track?.getSettings();
  const currentId = selectedId ?? settings?.deviceId;
  const index = devices.findIndex((device) => device.deviceId === currentId);
  const current = devices[index];
  const capabilities = track?.getCapabilities?.().facingMode;
  const currentFacing = (current && facing(current.label)) ?? settings?.facingMode ?? (capabilities?.length === 1 ? capabilities[0] : undefined);
  const opposite = currentFacing === "user" ? "environment" : currentFacing === "environment" ? "user" : undefined;
  return (opposite && devices.find((device) => device.deviceId !== currentId && facing(device.label) === opposite)) || devices[(index + 1) % devices.length];
}
