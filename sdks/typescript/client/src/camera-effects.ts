/** Browser-only bootstrap. Native SDK entry points never import the segmentation runtime. */
import { configureCameraEffectProvider, createCameraEffectsTrack as createTrack, type CameraEffectsAssets, type CameraEffectsProvider } from "./media/camera-effects";

const createSegmenter: CameraEffectsProvider = async (files) => {
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const vision = await FilesetResolver.forVisionTasks(files.wasmRoot);
  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: files.modelUrl, delegate: "GPU" },
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
};

export function configureCameraEffects(files: CameraEffectsAssets): void {
  configureCameraEffectProvider(files, createSegmenter);
}
export function createCameraEffectsTrack(source: MediaStreamTrack, files: CameraEffectsAssets) {
  return createTrack(source, files, createSegmenter);
}
export type { CameraEffectsAssets, CameraEffectsTrack } from "./media/camera-effects";
