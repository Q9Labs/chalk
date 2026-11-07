import { configureCameraEffects } from "@q9labsai/chalk-client/camera-effects";
import { CAMERA_VISION_ROOT, CAMERA_SEGMENTATION_MODEL } from "./camera-effect-assets";

configureCameraEffects({ wasmRoot: CAMERA_VISION_ROOT, modelUrl: CAMERA_SEGMENTATION_MODEL });
