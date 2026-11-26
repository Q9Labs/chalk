/** What a visitor picked on the pre-join step, kept per browser so the next visit is one click. */
export type RememberedDevices = {
  readonly microphone: boolean;
  readonly camera: boolean;
  readonly microphoneDeviceId?: string;
  readonly cameraDeviceId?: string;
  readonly speakerDeviceId?: string;
};

const STORAGE_KEY = "chalk.prejoin-devices";

export function readRememberedDevices(): RememberedDevices | null {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : parseRememberedDevices(JSON.parse(raw));
  } catch {
    return null; // Storage may be disabled or hold unreadable text; the visitor then starts from the defaults.
  }
}

export function rememberDevices(devices: RememberedDevices): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
  } catch {
    /* Joining works with storage disabled; the choice lasts until the page closes. */
  }
}

/** Drops the remembered device ids the browser no longer lists, so an unplugged headset does not pin the next join to a device that is gone. */
export async function listedRememberedDevices(devices: RememberedDevices): Promise<RememberedDevices> {
  const listed = (await globalThis.navigator?.mediaDevices?.enumerateDevices().catch(() => [])) ?? [];
  // Until the browser grants access it may list devices without ids; then nothing can be checked, so the saved id stays.
  const present = (id: string | undefined, kind: MediaDeviceKind) => {
    const ofKind = listed.filter((device) => device.kind === kind && device.deviceId !== "");
    return id !== undefined && (ofKind.length === 0 || ofKind.some((device) => device.deviceId === id));
  };
  const { microphoneDeviceId, cameraDeviceId, speakerDeviceId, ...toggles } = devices;
  return {
    ...toggles,
    ...(present(microphoneDeviceId, "audioinput") ? { microphoneDeviceId } : {}),
    ...(present(cameraDeviceId, "videoinput") ? { cameraDeviceId } : {}),
    ...(present(speakerDeviceId, "audiooutput") ? { speakerDeviceId } : {}),
  };
}

function parseRememberedDevices(value: unknown): RememberedDevices | null {
  if (typeof value !== "object" || value === null) return null;
  const { microphone, camera, microphoneDeviceId, cameraDeviceId, speakerDeviceId } = value as Partial<RememberedDevices>;
  if (typeof microphone !== "boolean" || typeof camera !== "boolean") return null;
  return {
    microphone,
    camera,
    ...(typeof microphoneDeviceId === "string" && microphoneDeviceId ? { microphoneDeviceId } : {}),
    ...(typeof cameraDeviceId === "string" && cameraDeviceId ? { cameraDeviceId } : {}),
    ...(typeof speakerDeviceId === "string" && speakerDeviceId ? { speakerDeviceId } : {}),
  };
}
