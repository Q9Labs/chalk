import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import type { CameraEffectsProvider } from "./media/camera-effects-track";

export const createSegmenter: CameraEffectsProvider = async (files) => {
  const vision = await FilesetResolver.forVisionTasks(files.wasmRoot);
  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: files.modelUrl, delegate: "GPU" },
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
};
