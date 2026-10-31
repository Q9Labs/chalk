/** Browser-only bootstrap. Native SDK entry points never import the segmentation runtime. */
import { configureCameraEffectProvider, loadCameraBackgroundControls, type CameraEffectsAssets, type CameraEffectsProvider } from "./media/camera-effects";

const createSegmenter: CameraEffectsProvider = async (files) => {
  const { createSegmenter } = await import("./camera-effects-provider");
  return createSegmenter(files);
};

export function configureCameraEffects(files: CameraEffectsAssets): void {
  configureCameraEffectProvider(files, createSegmenter);
}
export function createCameraEffectsTrack(source: MediaStreamTrack, files: CameraEffectsAssets) {
  return loadCameraBackgroundControls().then((controls) => controls.createCameraEffectsTrack(source, files, createSegmenter));
}
export type { CameraEffectsAssets, CameraEffectsTrack } from "./media/camera-effects";
