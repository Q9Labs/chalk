// The vendor versions the whiteboard is built against, written once. package.json dependencies must match,
// and the renderer build and the web app's asset sync fail when the installed packages differ.
// No imports: build-embedded.mjs runs this file directly under Node.
export const EXCALIDRAW_VERSION = "0.18.1";
export const MATHJAX_VERSION = "4.1.3";
const RENDERER_REVISION = 1;
export const RENDERER_BUILD_ID = `chalk-excalidraw-${EXCALIDRAW_VERSION}-r${RENDERER_REVISION}` as const;
export const EXCALIDRAW_CDN_CSS = `https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/prod/index.css`;
export const MATHJAX_CDN_SCRIPT = `https://cdn.jsdelivr.net/npm/mathjax@${MATHJAX_VERSION}/tex-svg-nofont.js`;
