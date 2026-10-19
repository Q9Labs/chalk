import type { MediaDevice, MediaSlice } from "@q9labsai/chalk-client";

export type CameraFacing = "front" | "back";

const BACK = /back|rear|environment/i;

function facingOf(device: MediaDevice | undefined): CameraFacing {
  return device && BACK.test(device.label) ? "back" : "front";
}

/** Which way your selected camera faces. Without a selection the phone uses the front camera. */
export function cameraFacing(media: MediaSlice): CameraFacing {
  return facingOf(media.devices.cameras.find((camera) => camera.deviceId === media.selection.camera));
}

/** The camera facing the other way, or null when the phone has only one. */
export function otherCamera(media: MediaSlice): MediaDevice | null {
  const current = cameraFacing(media);
  return media.devices.cameras.find((camera) => facingOf(camera) !== current) ?? null;
}
