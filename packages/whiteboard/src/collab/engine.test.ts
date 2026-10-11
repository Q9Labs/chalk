// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "./types";

beforeAll(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false }));
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => ({ filter: "none", measureText: () => ({ width: 0 }) })) });
});

it.each(["snapshot", "clear update"])("discards the retired scene after a new-scene %s", async (kind) => {
  const { restoreAppState, restoreElements } = await import("@excalidraw/excalidraw");
  const { ExcalidrawCollabEngine } = await import("./engine");
  const api = createCanvas(restoreElements, restoreAppState);
  api.updateScene({ elements: restoreElements([{ type: "rectangle", id: "old-rectangle", x: 0, y: 0, width: 100, height: 100, version: 1, versionNonce: 1, isDeleted: false }], null) });
  const engine = new ExcalidrawCollabEngine({ excalidrawAPI: api, canDraw: true, submitUpdate: async (input) => ({ operationId: "operation", sceneId: input.sceneId, revision: "3" }), sendCursor: vi.fn(), requestSnapshot: async () => undefined, clear: vi.fn(), subscribe: () => () => undefined });
  try {
    engine.handleRemoteSnapshot({ sceneId: "before-clear", elements: [] });
    expect(api.getSceneElementsIncludingDeleted().map((element) => element.id)).toEqual(["old-rectangle"]);
    // A same-scene recovery must still retain uncommitted local drawing.
    engine.handleRemoteSnapshot({ sceneId: "before-clear", elements: [] });
    expect(api.getSceneElementsIncludingDeleted().map((element) => element.id)).toEqual(["old-rectangle"]);
    expect(api.history.clear).not.toHaveBeenCalled();
    if (kind === "snapshot") engine.handleRemoteSnapshot({ sceneId: "after-clear", elements: [] });
    else engine.handleRemoteData({ sceneId: "after-clear", syncAll: true, elements: [] });
    expect(api.getSceneElementsIncludingDeleted()).toEqual([]);
    expect(api.history.clear).toHaveBeenCalledOnce();
  } finally {
    engine.dispose();
  }
});

afterEach(() => vi.useRealTimers());

it.each(["initial snapshot", "recovery snapshot", "remote update"])("submits only the retained local draft after an %s", async (kind) => {
  const { restoreAppState, restoreElements } = await import("@excalidraw/excalidraw");
  const { ExcalidrawCollabEngine } = await import("./engine");
  const { toWireElement } = await import("./wire");
  vi.useFakeTimers();
  const api = createCanvas(restoreElements, restoreAppState);
  const make = (id: string, version = 1, versionNonce = 1) => restoreElements([{ type: "rectangle", id, index: id === "received" ? "a0" : id === "edited" ? "a1" : "a2", x: 0, y: 0, width: 100, height: 100, version, versionNonce, isDeleted: false }], null);
  const received = make("received");
  const old = make("edited");
  const submitUpdate = vi.fn(async (input: { sceneId: string }) => ({ operationId: "operation", sceneId: input.sceneId, revision: "2" }));
  const engine = new ExcalidrawCollabEngine({ excalidrawAPI: api, canDraw: true, submitUpdate, sendCursor: vi.fn(), requestSnapshot: async () => undefined, clear: vi.fn(), subscribe: () => () => undefined });
  try {
    if (kind !== "initial snapshot") engine.handleRemoteSnapshot({ sceneId: "scene", elements: [...received, ...old].map(toWireElement) });
    // There is no user action after the incoming scene; initial debounce has already run.
    api.updateScene({ elements: [...received, ...make("edited", 2), ...make("draft")] });
    if (kind !== "remote update") {
      engine.handleChange(api.getSceneElementsIncludingDeleted(), restoreAppState({}, null), {});
      if (kind === "initial snapshot") await vi.advanceTimersByTimeAsync(150);
    }
    if (kind === "remote update") engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: old.map(toWireElement) });
    else engine.handleRemoteSnapshot({ sceneId: "scene", elements: [...received, ...old].map(toWireElement) });
    await vi.advanceTimersByTimeAsync(0);
    expect(submitUpdate).toHaveBeenCalledOnce();
    expect(submitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ syncAll: false, elements: [expect.objectContaining({ id: "edited", version: 2 }), expect.objectContaining({ id: "draft" })] }));
    engine.handleRemoteSnapshot({ sceneId: "scene", elements: api.getSceneElementsIncludingDeleted().map(toWireElement) });
    engine.handleChange(api.getSceneElementsIncludingDeleted(), restoreAppState({}, null), {});
    await vi.advanceTimersByTimeAsync(150);
    expect(submitUpdate).toHaveBeenCalledOnce();
  } finally {
    engine.dispose();
  }
});

it("submits a local version that wins an equal-version reconciliation without echoing the remote winner", async () => {
  const { restoreAppState, restoreElements } = await import("@excalidraw/excalidraw");
  const { ExcalidrawCollabEngine } = await import("./engine");
  const { toWireElement } = await import("./wire");
  vi.useFakeTimers();
  const api = createCanvas(restoreElements, restoreAppState);
  const local = restoreElements([{ type: "rectangle", id: "conflict", index: "a0", x: 0, y: 0, width: 100, height: 100, version: 2, versionNonce: 1, isDeleted: false }], null);
  const remote = restoreElements([{ ...local[0], versionNonce: 2 }], null);
  api.updateScene({ elements: local });
  const submitUpdate = vi.fn(async (input: { sceneId: string }) => ({ operationId: "operation", sceneId: input.sceneId, revision: "2" }));
  const engine = new ExcalidrawCollabEngine({ excalidrawAPI: api, canDraw: true, submitUpdate, sendCursor: vi.fn(), requestSnapshot: async () => undefined, clear: vi.fn(), subscribe: () => () => undefined });
  try {
    engine.handleRemoteSnapshot({ sceneId: "scene", elements: remote.map(toWireElement) });
    await vi.advanceTimersByTimeAsync(0);
    expect(submitUpdate).toHaveBeenCalledOnce();
    expect(submitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ elements: [expect.objectContaining({ id: "conflict", version_nonce: 1 })] }));
    const winner = restoreElements([{ ...local[0], version: 3, versionNonce: 3 }], null);
    engine.handleRemoteSnapshot({ sceneId: "scene", elements: winner.map(toWireElement) });
    await vi.advanceTimersByTimeAsync(150);
    expect(submitUpdate).toHaveBeenCalledOnce();
  } finally {
    engine.dispose();
  }
});

function createCanvas(restoreElements: typeof import("@excalidraw/excalidraw").restoreElements, restoreAppState: typeof import("@excalidraw/excalidraw").restoreAppState): ExcalidrawImperativeAPI {
  let elements = restoreElements([], null);
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
  return api;
}
