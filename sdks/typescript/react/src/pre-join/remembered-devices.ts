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

function parseRememberedDevices(value: unknown): RememberedDevices | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (key: string): unknown => Reflect.get(value, key);
  const id = (key: string): string | undefined => {
    const candidate = field(key);
    return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
  };
  const microphone = field("microphone");
  const camera = field("camera");
  if (typeof microphone !== "boolean" || typeof camera !== "boolean") return null;
  const [microphoneDeviceId, cameraDeviceId, speakerDeviceId] = [id("microphoneDeviceId"), id("cameraDeviceId"), id("speakerDeviceId")];
  return { microphone, camera, ...(microphoneDeviceId ? { microphoneDeviceId } : {}), ...(cameraDeviceId ? { cameraDeviceId } : {}), ...(speakerDeviceId ? { speakerDeviceId } : {}) };
}
