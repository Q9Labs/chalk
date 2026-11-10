import type { CameraBackground, CameraBackgroundPreset } from "./camera-background-settings";
import { CAMERA_BACKGROUND_URLS } from "./camera-background-urls.generated";

type CameraBackgroundImage = { readonly id: CameraBackgroundPreset; readonly label: string; readonly avif: string; readonly image: string };

export const CAMERA_BACKGROUND_IMAGES = {
  "modern-acoustic-office": { id: "modern-acoustic-office", label: "Office", ...CAMERA_BACKGROUND_URLS["modern-acoustic-office"] },
  "warm-executive-home-office": { id: "warm-executive-home-office", label: "Home office", ...CAMERA_BACKGROUND_URLS["warm-executive-home-office"] },
  "bright-creative-studio": { id: "bright-creative-studio", label: "Studio", ...CAMERA_BACKGROUND_URLS["bright-creative-studio"] },
  "garden-terrace-lounge": { id: "garden-terrace-lounge", label: "Garden", ...CAMERA_BACKGROUND_URLS["garden-terrace-lounge"] },
  "soft-abstract-glass": { id: "soft-abstract-glass", label: "Glass", ...CAMERA_BACKGROUND_URLS["soft-abstract-glass"] },
  "cozy-evening-lounge": { id: "cozy-evening-lounge", label: "Lounge", ...CAMERA_BACKGROUND_URLS["cozy-evening-lounge"] },
} as const satisfies Record<CameraBackgroundPreset, CameraBackgroundImage>;

export const CAMERA_BACKGROUND_OPTIONS: readonly { readonly id: CameraBackground; readonly label: string; readonly image?: string; readonly avif?: string }[] = [{ id: "none", label: "None" }, { id: "blur", label: "Blur" }, ...Object.values(CAMERA_BACKGROUND_IMAGES)];
