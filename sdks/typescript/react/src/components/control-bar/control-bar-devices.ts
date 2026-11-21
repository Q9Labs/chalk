export interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}

export function mergeDevices(...deviceGroups: ReadonlyArray<readonly MediaDevice[] | undefined>): MediaDevice[] {
  const devicesById = new Map<string, MediaDevice>();
  for (const deviceGroup of deviceGroups) {
    for (const device of deviceGroup ?? []) {
      const existing = devicesById.get(device.deviceId);
      if (!existing || (!existing.label && device.label)) {
        devicesById.set(device.deviceId, device);
      }
    }
  }
  return [...devicesById.values()];
}

export function withSelectedDeviceFallback(devices: readonly MediaDevice[] | undefined, selectedDeviceId: string | undefined, fallbackLabel: string, kind: MediaDevice["kind"]): MediaDevice[] {
  if (devices?.length) return [...devices];
  return selectedDeviceId ? [{ deviceId: selectedDeviceId, label: fallbackLabel, kind }] : [];
}
