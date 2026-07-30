import { describe, expect, it } from "vitest";

import { CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION, CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION, CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID } from "./protocol";
import { chalkEmbeddedWhiteboardManifest, chalkEmbeddedWhiteboardSupportedElementTypes } from "./manifest";

describe("embedded whiteboard compatibility manifest", () => {
  it("pins the runtime boundary and its local package entrypoint", () => {
    expect(chalkEmbeddedWhiteboardManifest).toMatchObject({
      rendererBuildId: CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID,
      bridge: { current: CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION },
      excalidraw: { version: CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION },
      entrypoint: "chalk-whiteboard/index.html",
    });
    expect(chalkEmbeddedWhiteboardManifest.security).toMatchObject({
      networkPolicy: "offline-only",
      rendererReceivesCredentials: false,
      rendererReceivesSignedURLs: false,
    });
    expect(chalkEmbeddedWhiteboardSupportedElementTypes.size).toBeGreaterThan(0);
    expect(chalkEmbeddedWhiteboardSupportedElementTypes.has("rectangle")).toBe(true);
  });
});
