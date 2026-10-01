// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "./types";

beforeAll(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false }));
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => ({ filter: "none", measureText: () => ({ width: 0 }) })) });
});

it.each(["snapshot", "clear update"])("discards the retired scene after a new-scene %s", async (kind) => {
  const { restoreAppState, restoreElements } = await import("@excalidraw/excalidraw");
  const { ExcalidrawCollabEngine } = await import("./engine");
  let elements = restoreElements([{ type: "rectangle", id: "old-rectangle", x: 0, y: 0, width: 100, height: 100, version: 1, versionNonce: 1, isDeleted: false }], null);
  const api: ExcalidrawImperativeAPI = {
    id: "canvas",
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElements: () => elements,
    getAppState: () => restoreAppState({}, null),
    getFiles: () => ({}),
    getName: () => "Board",
    updateScene: vi.fn((scene) => {
      if (scene.elements) elements = restoreElements(scene.elements, null);
    }),
    updateLibrary: vi.fn(),
    resetScene: vi.fn(),
    history: { clear: vi.fn() },
    scrollToContent: vi.fn(),
    registerAction: vi.fn(),
    refresh: vi.fn(),
    setToast: vi.fn(),
    addFiles: vi.fn(),
    setActiveTool: vi.fn(),
    setCursor: vi.fn(),
    resetCursor: vi.fn(),
    toggleSidebar: vi.fn(),
    updateFrameRendering: vi.fn(),
    onChange: () => () => undefined,
    onPointerDown: () => () => undefined,
    onPointerUp: () => () => undefined,
    onScrollChange: () => () => undefined,
    onUserFollow: () => () => undefined,
  };
  const engine = new ExcalidrawCollabEngine({ excalidrawAPI: api, canDraw: true, submitUpdate: async (input) => ({ sceneId: input.sceneId, revision: "3" }), sendCursor: vi.fn(), requestSnapshot: async () => undefined, clear: vi.fn(), subscribe: () => () => undefined });
  try {
    engine.handleRemoteSnapshot({ sceneId: "before-clear", elements: [] });
    expect(elements.map((element) => element.id)).toEqual(["old-rectangle"]);
    // A same-scene recovery must still retain uncommitted local drawing.
    engine.handleRemoteSnapshot({ sceneId: "before-clear", elements: [] });
    expect(elements.map((element) => element.id)).toEqual(["old-rectangle"]);
    expect(api.history.clear).not.toHaveBeenCalled();
    if (kind === "snapshot") engine.handleRemoteSnapshot({ sceneId: "after-clear", elements: [] });
    else engine.handleRemoteData({ sceneId: "after-clear", syncAll: true, elements: [] });
    expect(elements).toEqual([]);
    expect(api.history.clear).toHaveBeenCalledOnce();
  } finally {
    engine.dispose();
  }
});
