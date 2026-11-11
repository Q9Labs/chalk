export type DetectedMediaDevices = {
  readonly audioinput: MediaDeviceInfo[];
  readonly audiooutput: MediaDeviceInfo[];
  readonly videoinput: MediaDeviceInfo[];
};

export const NO_DETECTED_DEVICES: DetectedMediaDevices = { audioinput: [], audiooutput: [], videoinput: [] };

/** Reports the browser's device list now and after each `devicechange`; `refresh` reads it again, for example once permission adds labels. */
export function watchMediaDevices(onChange: (devices: DetectedMediaDevices) => void): { readonly refresh: () => void; readonly stop: () => void } {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.enumerateDevices) return { refresh: () => undefined, stop: () => undefined };
  let cancelled = false;
  const refresh = async () => {
    let devices = NO_DETECTED_DEVICES;
    try {
      const all = await mediaDevices.enumerateDevices();
      devices = { audioinput: all.filter((device) => device.kind === "audioinput"), audiooutput: all.filter((device) => device.kind === "audiooutput"), videoinput: all.filter((device) => device.kind === "videoinput") };
    } catch {
      /* A list the browser refuses to give reads as no devices. */
    }
    if (!cancelled) onChange(devices);
  };
  void refresh();
  mediaDevices.addEventListener?.("devicechange", refresh);
  return {
    refresh: () => void refresh(),
    stop: () => {
      cancelled = true;
      mediaDevices.removeEventListener?.("devicechange", refresh);
    },
  };
}
