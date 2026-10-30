import { configureCameraEffects } from "@q9labsai/chalk-client";
import { CAMERA_VISION_ROOT, CAMERA_SEGMENTATION_MODEL } from "./camera-effect-assets";

configureCameraEffects({ wasmRoot: CAMERA_VISION_ROOT, modelUrl: CAMERA_SEGMENTATION_MODEL });
