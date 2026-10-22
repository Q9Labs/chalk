import { configureWhiteboardAssets } from "@q9labsai/chalk-whiteboard/assets";
import { EXCALIDRAW_ASSET_VERSION, MATHJAX_ASSET_VERSION } from "./whiteboard-asset-versions";

configureWhiteboardAssets({
  excalidrawCssPath: `/chalk-whiteboard/${EXCALIDRAW_ASSET_VERSION}/index.css`,
  mathJaxBasePath: `/chalk-mathjax/${MATHJAX_ASSET_VERSION}`,
});
