import { configureWhiteboardAssets } from "@q9labsai/chalk-whiteboard/assets";
import { EXCALIDRAW_ASSET_ROOT, MATHJAX_ASSET_ROOT } from "./whiteboard-asset-versions";

configureWhiteboardAssets({
  excalidrawCssPath: `${EXCALIDRAW_ASSET_ROOT}/index.css`,
  mathJaxBasePath: MATHJAX_ASSET_ROOT,
});
