export const canEnumerateMediaDevices = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.enumerateDevices === "function";

export const enumerateMediaDevices = async (): Promise<MediaDeviceInfo[]> => {
  if (!canEnumerateMediaDevices()) {
    return [];
  }

  return navigator.mediaDevices.enumerateDevices();
};
