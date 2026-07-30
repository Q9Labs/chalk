import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "android" },
}));

import { isEmbeddedWhiteboardNavigationAllowed, rendererURLWithContext } from "./embedded-whiteboard-assets";

describe("embedded whiteboard asset policy", () => {
  it("adds only non-credential bridge context to the local renderer URL", () => {
    const url = rendererURLWithContext("file:///android_asset/chalk-whiteboard/index.html", {
      journeyId: "journey-1",
      rendererGeneration: "generation-1",
    });

    expect(url).toBe("file:///android_asset/chalk-whiteboard/index.html?journeyId=journey-1&rendererGeneration=generation-1");
    expect(url).not.toMatch(/token|credential|signature/iu);
  });

  it("allows renderer-local assets and rejects every remote navigation", () => {
    const renderer = "file:///android_asset/chalk-whiteboard/index.html";

    expect(isEmbeddedWhiteboardNavigationAllowed(renderer, renderer)).toBe(true);
    expect(isEmbeddedWhiteboardNavigationAllowed("file:///android_asset/chalk-whiteboard/fonts/Assistant/Assistant-Regular.woff2", renderer)).toBe(true);
    expect(isEmbeddedWhiteboardNavigationAllowed("file:///android_asset/chalk-whiteboard/../../data/user/0/secret", renderer)).toBe(false);
    expect(isEmbeddedWhiteboardNavigationAllowed("file:///android_asset/chalk-whiteboard/%2e%2e/%2e%2e/data/user/0/secret", renderer)).toBe(false);
    expect(isEmbeddedWhiteboardNavigationAllowed("https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw/index.css", renderer)).toBe(false);
    expect(isEmbeddedWhiteboardNavigationAllowed("javascript:alert(1)", renderer)).toBe(false);
  });
});
