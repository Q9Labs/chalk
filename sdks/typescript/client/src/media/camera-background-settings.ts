import { CHALK_BACKGROUND_ASSETS } from "@q9labsai/chalk-assets";

export type CameraBackground = "none" | "blur" | keyof typeof CHALK_BACKGROUND_ASSETS;
export const CAMERA_BACKGROUND_OPTIONS: readonly { readonly id: CameraBackground; readonly label: string; readonly image?: string; readonly avif?: string }[] = [
  { id: "none", label: "None" },
  { id: "blur", label: "Blur" },
  { id: "modern-acoustic-office", label: "Office", image: CHALK_BACKGROUND_ASSETS["modern-acoustic-office"].webp.url, avif: CHALK_BACKGROUND_ASSETS["modern-acoustic-office"].avif.url },
  { id: "warm-executive-home-office", label: "Home office", image: CHALK_BACKGROUND_ASSETS["warm-executive-home-office"].webp.url, avif: CHALK_BACKGROUND_ASSETS["warm-executive-home-office"].avif.url },
  { id: "bright-creative-studio", label: "Studio", image: CHALK_BACKGROUND_ASSETS["bright-creative-studio"].webp.url, avif: CHALK_BACKGROUND_ASSETS["bright-creative-studio"].avif.url },
  { id: "garden-terrace-lounge", label: "Garden", image: CHALK_BACKGROUND_ASSETS["garden-terrace-lounge"].webp.url, avif: CHALK_BACKGROUND_ASSETS["garden-terrace-lounge"].avif.url },
  { id: "soft-abstract-glass", label: "Glass", image: CHALK_BACKGROUND_ASSETS["soft-abstract-glass"].webp.url, avif: CHALK_BACKGROUND_ASSETS["soft-abstract-glass"].avif.url },
  { id: "cozy-evening-lounge", label: "Lounge", image: CHALK_BACKGROUND_ASSETS["cozy-evening-lounge"].webp.url, avif: CHALK_BACKGROUND_ASSETS["cozy-evening-lounge"].avif.url },
];

export function isCameraBackground(value: unknown): value is CameraBackground {
  return CAMERA_BACKGROUND_OPTIONS.some((option) => option.id === value);
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
