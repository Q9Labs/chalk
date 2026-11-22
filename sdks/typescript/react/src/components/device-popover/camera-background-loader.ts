import { preloadable } from "../../internal/preloadable";

/**
 * The Background rows load in two steps: the picker chunk, then the camera controls it lists. Both start
 * on intent, so a camera menu opened after a hover or focus has its final height on the first frame.
 * A controls failure resolves here; the picker retries and shows its own error.
 */
export const cameraBackgroundPicker = preloadable(() =>
  import("./CameraBackgroundPicker").then((module) =>
    module.preloadCameraBackgroundControls().then(
      () => module.CameraBackgroundPicker,
      () => module.CameraBackgroundPicker,
    ),
  ),
);

export function preloadCameraBackgrounds(): void {
  void cameraBackgroundPicker.preload().catch(() => undefined);
}
