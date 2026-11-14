import { configureWhiteboardAssets } from "@q9labsai/chalk-whiteboard/assets";
import { EXCALIDRAW_ASSET_ROOT, MATHJAX_ASSET_ROOT } from "./whiteboard-asset-versions";

/** Points the board package at the self-hosted Excalidraw and MathJax trees this app serves. */
export function installWhiteboardAssets() {
  configureWhiteboardAssets({
    excalidrawCssPath: `${EXCALIDRAW_ASSET_ROOT}/index.css`,
    mathJaxBasePath: MATHJAX_ASSET_ROOT,
  });
}
