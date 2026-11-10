const CAMERA_BACKGROUND_PRESET_IDS = ["modern-acoustic-office", "warm-executive-home-office", "bright-creative-studio", "garden-terrace-lounge", "soft-abstract-glass", "cozy-evening-lounge"] as const;

export type CameraBackgroundPreset = (typeof CAMERA_BACKGROUND_PRESET_IDS)[number];
export type CameraBackground = "none" | "blur" | CameraBackgroundPreset;

export function isCameraBackground(value: unknown): value is CameraBackground {
  return value === "none" || value === "blur" || CAMERA_BACKGROUND_PRESET_IDS.some((id) => id === value);
}

/** A blocked or full storage area still remembers choices for this page. */
export class CameraBackgroundPreferences {
  readonly #values = new Map<string, CameraBackground>();
  readonly #storage: () => Pick<Storage, "getItem" | "setItem">;
  constructor(storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage) {
    this.#storage = storage;
  }
  get(deviceId: string): CameraBackground {
    const cached = this.#values.get(deviceId);
    if (cached) return cached;
    let value: CameraBackground = "none";
    try {
      const stored = this.#storage().getItem(this.#key(deviceId));
      if (isCameraBackground(stored)) value = stored;
    } catch {
      // Private or blocked storage uses the page's in-memory preferences.
    }
    this.#values.set(deviceId, value);
    return value;
  }
  set(deviceId: string, value: CameraBackground): void {
    this.#values.set(deviceId, value);
    try {
      this.#storage().setItem(this.#key(deviceId), value);
    } catch {
      // The choice remains usable when storage is blocked or full.
    }
  }
  #key(deviceId: string): string {
    return `chalk_camera_background:${deviceId}`;
  }
}
