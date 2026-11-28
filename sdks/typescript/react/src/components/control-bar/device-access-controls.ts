import type { useMedia, useSpaceClient } from "../../bindings/hooks";
import type { DeviceAccessControl } from "../device-access/DeviceAccessCard";
import type { DeviceKind } from "../device-access/model";
import type { useDeviceAccess } from "../device-access/useDeviceAccess";
import type { MediaCommandAction, MediaCommandSource } from "./command-failure";

type Run = (command: () => Promise<unknown>, source?: MediaCommandSource, action?: MediaCommandAction) => Promise<void>;

/** Picks the browser's first listed device, then turns the device on. */
async function useFirstDevice(client: ReturnType<typeof useSpaceClient>, device: "microphone" | "camera", deviceId: string): Promise<void> {
  await (device === "microphone" ? client.media.selectMicrophone(deviceId) : client.media.selectCamera(deviceId));
  await (device === "microphone" ? client.media.setMicrophoneEnabled(true) : client.media.setCameraEnabled(true));
}

/** What each dock button needs to show its refusal and open the card. */
export function deviceAccessControls(options: { readonly access: ReturnType<typeof useDeviceAccess>; readonly media: ReturnType<typeof useMedia>; readonly client: ReturnType<typeof useSpaceClient>; readonly run: Run }): Partial<Record<DeviceKind, DeviceAccessControl>> {
  const { access, media, client, run } = options;
  const controls: Partial<Record<DeviceKind, DeviceAccessControl>> = {};
  for (const device of ["microphone", "camera", "screen"] as const) {
    const issue = access.snapshot.issues[device];
    if (!issue || media.local[device].state === "enabled") continue;
    const first = device === "microphone" ? media.devices.microphones[0] : device === "camera" ? media.devices.cameras[0] : undefined;
    const onUseDefault = device !== "screen" && first ? () => void run(() => useFirstDevice(client, device, first.deviceId), device, "start") : undefined;
    controls[device] = { ...issue, onOpenChange: (open) => access.store.setOpen(device, open), onRetry: () => void access.store.retry(device), onUseDefault, defaultDeviceLabel: first?.label || undefined };
  }
  return controls;
}
