// Each asset URL names the upstream version and a digest of the copied bytes, so a patched
// dependency can't change the bytes behind an immutable URL. sync-public-assets.ts checks
// both against the installed packages and prints the new digest when the bytes change.
export const EXCALIDRAW_ASSET_VERSION = "0.18.1";
export const EXCALIDRAW_ASSET_DIGEST = "e62e08179b0a8026";
export const MATHJAX_ASSET_VERSION = "4.1.3";
export const MATHJAX_ASSET_DIGEST = "79d3d8e11a7885dd";

export const EXCALIDRAW_ASSET_ROOT = `/chalk-whiteboard/${EXCALIDRAW_ASSET_VERSION}-${EXCALIDRAW_ASSET_DIGEST}`;
export const MATHJAX_ASSET_ROOT = `/chalk-mathjax/${MATHJAX_ASSET_VERSION}-${MATHJAX_ASSET_DIGEST}`;
