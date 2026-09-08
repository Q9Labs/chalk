// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { applyEmbeddedWhiteboardViewport } from "./renderer-viewport";

describe("embedded whiteboard viewport", () => {
  it("resizes to the measured Board rectangle without changing the local camera", () => {
    let appState = { viewBackgroundColor: "#ffffff", scrollX: 84, scrollY: -32, zoom: { value: 1.5 } };
    const container = document.createElement("div");
    const refresh = vi.fn(() => {
      appState = { viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 1 } };
    });
    const updateScene = vi.fn((scene: { readonly appState: typeof appState }) => {
      appState = scene.appState;
    });

    applyEmbeddedWhiteboardViewport({ getAppState: () => appState, refresh, updateScene }, container, {
      width: 712,
      height: 438,
      scale: 2,
    });

    expect(container.style.width).toBe("712px");
    expect(container.style.height).toBe("438px");
    expect(refresh).toHaveBeenCalledOnce();
    expect(appState).toEqual({ viewBackgroundColor: "#ffffff", scrollX: 84, scrollY: -32, zoom: { value: 1.5 } });
  });
});
