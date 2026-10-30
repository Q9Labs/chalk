import { CAMERA_BACKGROUND_IMAGES } from "./camera-background-images";

export type CameraBackground = "none" | "blur" | keyof typeof CAMERA_BACKGROUND_IMAGES;
export const CAMERA_BACKGROUND_OPTIONS: readonly { readonly id: CameraBackground; readonly label: string; readonly image?: string; readonly avif?: string }[] = [
  { id: "none", label: "None" },
  { id: "blur", label: "Blur" },
  { id: "modern-acoustic-office", label: "Office", image: CAMERA_BACKGROUND_IMAGES["modern-acoustic-office"].webp.url, avif: CAMERA_BACKGROUND_IMAGES["modern-acoustic-office"].avif.url },
  { id: "warm-executive-home-office", label: "Home office", image: CAMERA_BACKGROUND_IMAGES["warm-executive-home-office"].webp.url, avif: CAMERA_BACKGROUND_IMAGES["warm-executive-home-office"].avif.url },
  { id: "bright-creative-studio", label: "Studio", image: CAMERA_BACKGROUND_IMAGES["bright-creative-studio"].webp.url, avif: CAMERA_BACKGROUND_IMAGES["bright-creative-studio"].avif.url },
  { id: "garden-terrace-lounge", label: "Garden", image: CAMERA_BACKGROUND_IMAGES["garden-terrace-lounge"].webp.url, avif: CAMERA_BACKGROUND_IMAGES["garden-terrace-lounge"].avif.url },
  { id: "soft-abstract-glass", label: "Glass", image: CAMERA_BACKGROUND_IMAGES["soft-abstract-glass"].webp.url, avif: CAMERA_BACKGROUND_IMAGES["soft-abstract-glass"].avif.url },
  { id: "cozy-evening-lounge", label: "Lounge", image: CAMERA_BACKGROUND_IMAGES["cozy-evening-lounge"].webp.url, avif: CAMERA_BACKGROUND_IMAGES["cozy-evening-lounge"].avif.url },
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
