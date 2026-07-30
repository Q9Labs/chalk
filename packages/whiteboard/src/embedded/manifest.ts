import { CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION, CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION, CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID } from "./protocol.js";
import compatibilityManifest from "./compatibility-manifest.json";

export const chalkEmbeddedWhiteboardManifest = Object.freeze({
  ...compatibilityManifest,
  rendererBuildId: CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID,
  bridge: Object.freeze({
    ...compatibilityManifest.bridge,
    current: CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION,
  }),
  excalidraw: Object.freeze({
    ...compatibilityManifest.excalidraw,
    version: CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION,
  }),
  entrypoint: "chalk-whiteboard/index.html",
  bundledAssets: Object.freeze(["renderer.js", "index.css", "fonts/**", "mathjax/tex-svg.js", "THIRD_PARTY_NOTICES.json"]),
} as const);

export const chalkEmbeddedWhiteboardSupportedElementTypes: ReadonlySet<string> = new Set(compatibilityManifest.document.supportedElementTypes);
