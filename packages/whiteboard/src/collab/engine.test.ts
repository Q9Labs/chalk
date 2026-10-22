// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "./types";

beforeAll(async () => {
  window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false }));
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => ({ filter: "none", measureText: () => ({ width: 0 }) })) });
  // Excalidraw's cold import takes seconds in jsdom on a loaded runner. Load it once
  // here, so each test's timeout covers only its own work.
  await import("@excalidraw/excalidraw");
  await import("./engine");
}, 60_000);

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
  const { api, engine, submitUpdate, restoreElements, restoreAppState, toWireElement } = await createReconciliationFixture();
  const make = (id: string, version = 1, versionNonce = 1) => restoreElements([{ type: "rectangle", id, index: id === "received" ? "a0" : id === "edited" ? "a1" : "a2", x: 0, y: 0, width: 100, height: 100, version, versionNonce, isDeleted: false }], null);
  const received = make("received");
  const old = make("edited");
  try {
    if (kind !== "initial snapshot") engine.handleRemoteSnapshot({ sceneId: "scene", elements: [...received, ...old].map(toWireElement) });
    // There is no user action after the incoming scene.
    api.updateScene({ elements: [...received, ...make("edited", 2), ...make("draft")] });
    engine.handleChange(api.getSceneElementsIncludingDeleted(), restoreAppState({}, null), {});
    if (kind === "initial snapshot") await vi.advanceTimersByTimeAsync(150);
    if (kind === "remote update") engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: old.map(toWireElement) });
    else engine.handleRemoteSnapshot({ sceneId: "scene", elements: [...received, ...old].map(toWireElement) });
    await vi.advanceTimersByTimeAsync(kind === "remote update" ? 150 : 0);
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

it("keeps retained local drafts on the existing debounce during incremental remote updates", async () => {
  const { api, engine, submitUpdate, restoreElements, restoreAppState, toWireElement } = await createReconciliationFixture();
  const local = restoreElements([{ type: "rectangle", id: "draft", index: "a0", x: 0, y: 0, width: 100, height: 100, version: 1, versionNonce: 1, isDeleted: false }], null);
  const remote = restoreElements([{ ...local[0], id: "remote", index: "a1" }], null);
  try {
    engine.handleRemoteSnapshot({ sceneId: "scene", elements: [] });
    api.updateScene({ elements: local });
    engine.handleChange(api.getSceneElementsIncludingDeleted(), restoreAppState({}, null), {});
    await vi.advanceTimersByTimeAsync(50);
    engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: remote.map(toWireElement) });
    await vi.advanceTimersByTimeAsync(50);
    engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: remote.map(toWireElement) });
    await vi.advanceTimersByTimeAsync(49);
    expect(submitUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(submitUpdate).toHaveBeenCalledOnce();
    expect(submitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ syncAll: false, elements: [expect.objectContaining({ id: "draft" })] }));
  } finally {
    engine.dispose();
  }
});

it("submits a local version that wins an equal-version reconciliation without echoing the remote winner", async () => {
  const { api, engine, submitUpdate, restoreElements, restoreAppState, toWireElement } = await createReconciliationFixture();
  const local = restoreElements([{ type: "rectangle", id: "conflict", index: "a0", x: 0, y: 0, width: 100, height: 100, version: 2, versionNonce: 1, isDeleted: false }], null);
  const remote = restoreElements([{ ...local[0], versionNonce: 2 }], null);
  api.updateScene({ elements: local });
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

it("paints canonical Ink in the viewer's surface ink and sends it back canonical", async () => {
  const { api, engine, submitUpdate, restoreElements, restoreAppState, toWireElement } = await createReconciliationFixture({ inkColor: "#f1f0ea" });
  const stroke = (id: string, strokeColor: string, version = 1) => restoreElements([{ type: "rectangle", id, index: id === "remote" ? "a0" : "a1", x: 0, y: 0, width: 10, height: 10, strokeColor, version, versionNonce: 1, isDeleted: false }], null);
  const colors = () => api.getSceneElementsIncludingDeleted().map((element) => element.strokeColor);
  try {
    engine.handleRemoteSnapshot({ sceneId: "scene", elements: stroke("remote", "#1b1c1f").map(toWireElement) });
    expect(colors()).toEqual(["#f1f0ea"]);
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...stroke("local", "#f1f0ea")] });
    engine.handleChange(api.getSceneElementsIncludingDeleted(), restoreAppState({}, null), {});
    await vi.advanceTimersByTimeAsync(150);
    expect(submitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ elements: [expect.objectContaining({ id: "local", payload: expect.objectContaining({ strokeColor: "#1b1c1f" }) })] }));
    engine.setInkColor("#1b1c1f");
    engine.handleChange(api.getSceneElementsIncludingDeleted(), restoreAppState({}, null), {});
    await vi.advanceTimersByTimeAsync(150);
    expect(colors()).toEqual(["#1b1c1f", "#1b1c1f"]);
    expect(submitUpdate).toHaveBeenCalledOnce();
  } finally {
    engine.dispose();
  }
});

it("keeps a received empty text live, so a peer's undone text can be redone", async () => {
  const { api, engine, submitUpdate, restoreElements, restoreAppState, toWireElement } = await createReconciliationFixture();
  const [written] = restoreElements([{ type: "text", id: "qa-text", index: "a0", x: 0, y: 0, width: 80, height: 25, text: "QA text 1", originalText: "QA text 1", fontSize: 20, fontFamily: 5, lineHeight: 1.25, textAlign: "left", verticalAlign: "top", autoResize: false, containerId: null, version: 2, versionNonce: 2, isDeleted: false }], null);
  if (!written) throw new Error("Text element is missing");
  // Like Excalidraw, this canvas takes elements as given: updateScene does not restore them.
  let scene: readonly (typeof written)[] = [];
  api.getSceneElementsIncludingDeleted = () => scene;
  api.updateScene = vi.fn((update) => {
    if (update.elements) scene = [...update.elements];
  });
  try {
    engine.handleRemoteSnapshot({ sceneId: "scene", elements: [toWireElement(written)] });
    // The writer's Undo of a new text leaves the element empty but live, one version up.
    const undone = { ...written, text: "", originalText: "", version: 3, versionNonce: 3 };
    engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: [toWireElement(undone)] });
    engine.handleChange(api.getSceneElementsIncludingDeleted(), restoreAppState({}, null), {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.getSceneElementsIncludingDeleted()).toEqual([expect.objectContaining({ id: "qa-text", isDeleted: false, version: 3, versionNonce: 3 })]);
    // A viewer never writes back an element it only received; that echoed deletion is what made Redo lose the text.
    expect(submitUpdate).not.toHaveBeenCalled();
  } finally {
    engine.dispose();
  }
});

async function createReconciliationFixture(options: { readonly inkColor?: string; readonly canDraw?: boolean; readonly canManage?: boolean } = {}) {
  const { restoreAppState, restoreElements } = await import("@excalidraw/excalidraw");
  const { ExcalidrawCollabEngine } = await import("./engine");
  const { toWireElement } = await import("./wire");
  vi.useFakeTimers();
  const api = createCanvas(restoreElements, restoreAppState);
  const submitUpdate = vi.fn(async (input: { sceneId: string }) => ({ operationId: "operation", sceneId: input.sceneId, revision: "2" }));
  const engine = new ExcalidrawCollabEngine({ canDraw: true, ...options, excalidrawAPI: api, submitUpdate, sendCursor: vi.fn(), requestSnapshot: async () => undefined, clear: async () => ({ operationId: "clear", sceneId: "cleared", revision: "3" }), subscribe: () => () => undefined });
  return { api, engine, submitUpdate, restoreElements, restoreAppState, toWireElement };
}

function createCanvas(restoreElements: typeof import("@excalidraw/excalidraw").restoreElements, restoreAppState: typeof import("@excalidraw/excalidraw").restoreAppState, pointerUps: (() => void)[] = []): ExcalidrawImperativeAPI {
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
    onPointerUp: (callback) => {
      pointerUps.push(() => Reflect.apply(callback, undefined, []));
      return () => undefined;
    },
    onScrollChange: () => () => undefined,
    onUserFollow: () => () => undefined,
  };
  return api;
}

it("acknowledges the submitted version, then delivers final points mutated during the submit", async () => {
  const fixture = await createDeliveryFixture();
  const pending = deferredCommit();
  fixture.submitUpdate.mockImplementationOnce(() => pending.promise);
  try {
    fixture.draw("stroke", 1);
    await vi.advanceTimersByTimeAsync(150);
    const stroke = fixture.api.getSceneElementsIncludingDeleted()[0];
    Object.assign(stroke, { version: 2, versionNonce: 2, width: 200 });
    // Excalidraw mutates existing elements. No further input is needed to flush the final state.
    await acknowledgeFirstCommit(pending);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.submitUpdate.mock.calls[0]?.[0].elements[0]?.version).toBe(1);
    expect(fixture.submitUpdate.mock.calls[1]?.[0].elements[0]?.version).toBe(2);
    expect(fixture.submitUpdate.mock.calls[1]?.[0].elements[0]?.payload.width).toBe(200);
  } finally {
    fixture.engine.dispose();
  }
});

it.each(["overloaded", "storage_unavailable"])("retries only unacknowledged changes after %s, without more drawing", async (code) => {
  const fixture = await createDeliveryFixture();
  try {
    fixture.draw("acknowledged", 1);
    await vi.advanceTimersByTimeAsync(150);
    fixture.submitUpdate.mockRejectedValueOnce(new Error(code));
    fixture.draw("pending", 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(fixture.onSubmissionError).toHaveBeenCalledWith(expect.objectContaining({ message: code }));
    await vi.advanceTimersByTimeAsync(999);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(3);
    expect(fixture.submitUpdate.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ syncAll: false, elements: [expect.objectContaining({ id: "pending" })] }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(3);
  } finally {
    fixture.engine.dispose();
  }
});

it("keeps retrying a failed submission at a capped delay and resumes at once after a reconnect snapshot", async () => {
  const fixture = await createDeliveryFixture();
  try {
    fixture.submitUpdate.mockRejectedValue(new Error("overloaded"));
    fixture.draw("offline", 1);
    // Attempts at 0.15 s, then after 1, 2, 4, 8 and 16 s.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(7);
    fixture.submitUpdate.mockImplementation(async (input) => ({ operationId: "reconnected", sceneId: input.sceneId, revision: "2" }));
    fixture.engine.handleRemoteSnapshot({ sceneId: "scene", elements: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(8);
    expect(fixture.submitUpdate.mock.calls[7]?.[0].elements.map((element) => element.id)).toEqual(["offline"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(8);
  } finally {
    fixture.engine.dispose();
  }
});

it("delivers a failed change without more drawing once the server accepts it again", async () => {
  const fixture = await createDeliveryFixture();
  try {
    fixture.submitUpdate.mockRejectedValue(new Error("storage_unavailable"));
    fixture.draw("stuck", 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(4);
    fixture.submitUpdate.mockImplementation(async (input) => ({ operationId: "healed", sceneId: input.sceneId, revision: "2" }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(5);
    expect(fixture.submitUpdate.mock.calls[4]?.[0].elements.map((element) => element.id)).toEqual(["stuck"]);
  } finally {
    fixture.engine.dispose();
  }
});

it("sends a stroke finished during a submission as soon as it is acknowledged, while a co-writer's cursor keeps the canvas changing", async () => {
  const fixture = await createDeliveryFixture();
  const pending = deferredCommit();
  fixture.submitUpdate.mockImplementationOnce(() => pending.promise);
  try {
    fixture.draw("first", 1);
    fixture.pointerUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
    fixture.draw("second", 1);
    fixture.pointerUp();
    fixture.canvasChange();
    await acknowledgeFirstCommit(pending);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.submitUpdate.mock.calls[1]?.[0].elements.map((element) => element.id)).toEqual(["second"]);
  } finally {
    fixture.engine.dispose();
  }
});

it("sends a change within a second when a co-writer's cursor keeps the canvas changing", async () => {
  const fixture = await createDeliveryFixture();
  try {
    fixture.draw("typed", 1);
    for (let elapsed = 100; elapsed <= 900; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      fixture.canvasChange();
    }
    expect(fixture.submitUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
    for (let elapsed = 0; elapsed < 3_000; elapsed += 100) {
      fixture.canvasChange();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
  } finally {
    fixture.engine.dispose();
  }
});

it("does not let an old acknowledgement downgrade a newer remote version", async () => {
  const fixture = await createDeliveryFixture();
  const pending = deferredCommit();
  fixture.submitUpdate.mockImplementationOnce(() => pending.promise);
  try {
    fixture.draw("shared", 2);
    await vi.advanceTimersByTimeAsync(150);
    fixture.engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: fixture.make("shared", 3).map(fixture.toWireElement) });
    pending.resolve({ operationId: "old", sceneId: "scene", revision: "2" });
    await vi.advanceTimersByTimeAsync(0);
    fixture.engine.handleChange(fixture.api.getSceneElementsIncludingDeleted(), fixture.api.getAppState(), {});
    await vi.advanceTimersByTimeAsync(150);
    expect(fixture.api.getSceneElementsIncludingDeleted()[0]?.version).toBe(3);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
  } finally {
    fixture.engine.dispose();
  }
});

it("converges final points when two writers edit the same element with pending acknowledgements", async () => {
  const first = await createDeliveryFixture();
  const second = await createDeliveryFixture();
  const pendingFirst = deferredCommit();
  const pendingSecond = deferredCommit();
  first.submitUpdate.mockImplementationOnce(() => pendingFirst.promise);
  second.submitUpdate.mockImplementationOnce(() => pendingSecond.promise);
  try {
    first.draw("shared", 2, 1);
    second.draw("shared", 2, 2);
    await vi.advanceTimersByTimeAsync(150);
    Object.assign(first.api.getSceneElementsIncludingDeleted()[0], {
      version: 3,
      versionNonce: 3,
      points: [
        [0, 0],
        [100, 100],
        [200, 50],
      ],
      width: 200,
    });
    first.engine.handleChange(first.api.getSceneElementsIncludingDeleted(), first.api.getAppState(), {});
    const winner = first.submitUpdate.mock.calls[0]?.[0].elements ?? [];
    const loser = second.submitUpdate.mock.calls[0]?.[0].elements ?? [];
    first.engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: loser });
    second.engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: winner });
    pendingFirst.resolve({ operationId: "first", sceneId: "scene", revision: "1" });
    pendingSecond.resolve({ operationId: "second", sceneId: "scene", revision: "2" });
    await vi.advanceTimersByTimeAsync(150);
    expect(first.submitUpdate).toHaveBeenCalledTimes(2);
    const final = first.submitUpdate.mock.calls[1]?.[0].elements ?? [];
    second.engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: final });
    expect(first.api.getSceneElementsIncludingDeleted()[0]?.version).toBe(3);
    expect(second.api.getSceneElementsIncludingDeleted()[0]?.version).toBe(3);
    expect(second.api.getSceneElementsIncludingDeleted()[0]).toEqual(
      expect.objectContaining({
        points: [
          [0, 0],
          [100, 100],
          [200, 50],
        ],
      }),
    );
    expect(second.submitUpdate).toHaveBeenCalledOnce();
  } finally {
    first.engine.dispose();
    second.engine.dispose();
  }
});

it("sends nothing for a settled 1,629-stroke board left idle for 60 seconds", async () => {
  const fixture = await createDeliveryFixture();
  try {
    fixture.api.updateScene({ elements: Array.from({ length: 1629 }, (_, index) => fixture.make(`stroke-${index}`, 1)[0]).filter((element) => element !== undefined) });
    fixture.engine.handleChange(fixture.api.getSceneElementsIncludingDeleted(), fixture.api.getAppState(), {});
    await vi.advanceTimersByTimeAsync(150);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
  } finally {
    fixture.engine.dispose();
  }
});

it.each(["writer", "watcher"])("retains complete strokes across a 20-second cut on the %s", async (cutSide) => {
  const writer = await createDeliveryFixture();
  const watcher = await createDeliveryFixture();
  watcher.engine.setCanDraw(false);
  const pending = deferredCommit();
  let latest: readonly import("./wire").WhiteboardWireElement[] = [];
  writer.submitUpdate.mockImplementation(async (input) => {
    latest = input.elements;
    if (cutSide === "writer") await pending.promise;
    if (cutSide !== "watcher") watcher.engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: latest });
    return { operationId: "operation", sceneId: "scene", revision: "1" };
  });
  try {
    writer.draw("stroke", 1);
    await vi.advanceTimersByTimeAsync(150);
    const stroke = writer.api.getSceneElementsIncludingDeleted()[0];
    Object.assign(stroke, {
      version: 2,
      versionNonce: 2,
      points: [
        [0, 0],
        [100, 100],
        [200, 50],
      ],
      width: 200,
    });
    writer.engine.handleChange(writer.api.getSceneElementsIncludingDeleted(), writer.api.getAppState(), {});
    await vi.advanceTimersByTimeAsync(20_000);
    pending.resolve({ operationId: "reconnected", sceneId: "scene", revision: "1" });
    await vi.advanceTimersByTimeAsync(0);
    watcher.engine.handleRemoteSnapshot({ sceneId: "scene", elements: latest });
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.api.getSceneElementsIncludingDeleted()).toHaveLength(1);
    expect(watcher.api.getSceneElementsIncludingDeleted()[0]?.version).toBe(2);
    expect(watcher.api.getSceneElementsIncludingDeleted()[0]).toEqual(
      expect.objectContaining({
        points: [
          [0, 0],
          [100, 100],
          [200, 50],
        ],
      }),
    );
    expect(watcher.submitUpdate).not.toHaveBeenCalled();
    expect(writer.submitUpdate.mock.calls.every(([input]) => !input.syncAll)).toBe(true);
  } finally {
    writer.engine.dispose();
    watcher.engine.dispose();
  }
});

it("keeps ongoing input behind the debounce after an acknowledgement and still sends its final version", async () => {
  const fixture = await createDeliveryFixture();
  fixture.submitUpdate.mockImplementation(
    (input) =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ operationId: "delayed", sceneId: input.sceneId, revision: "1" }), 40);
      }),
  );
  try {
    fixture.draw("drag", 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
    for (let version = 2; version <= 21; version++) {
      fixture.draw("drag", version);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(150);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.submitUpdate.mock.calls[1]?.[0].elements[0]?.version).toBe(21);
  } finally {
    fixture.engine.dispose();
  }
});

it("leaves a stroke that is still being drawn to its own pointer-up when the canvas never goes quiet", async () => {
  const fixture = await createDeliveryFixture();
  const getAppState = fixture.api.getAppState;
  let drawing = true;
  fixture.api.getAppState = () => ({
    ...getAppState(),
    newElement: drawing ? (fixture.api.getSceneElementsIncludingDeleted().find((element) => element.id === "in-hand") ?? null) : null,
  });
  try {
    fixture.draw("finished", 1);
    for (let version = 1; version <= 30; version++) {
      fixture.draw("in-hand", version);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(fixture.submitUpdate.mock.calls.map((call) => call[0].elements.map((element) => element.id))).toEqual([["finished"]]);
    drawing = false;
    fixture.pointerUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.submitUpdate.mock.calls[1]?.[0].elements.map((element) => element.id)).toEqual(["in-hand"]);
    expect(fixture.submitUpdate.mock.calls[1]?.[0].elements[0]?.version).toBeGreaterThanOrEqual(30);
  } finally {
    fixture.engine.dispose();
  }
});

it.each(["drawing", "resizing"])("applies a winning peer edit once local %s on the same element ends", async (interaction) => {
  const fixture = await createDeliveryFixture();
  const finishEditing = trackLocalInteraction(fixture, interaction);
  try {
    await deferPeerEdit(fixture);
    expect(fixture.api.getSceneElementsIncludingDeleted()[0]?.version).toBe(2);
    await finishEditing();
    expect(fixture.api.getSceneElementsIncludingDeleted()[0]?.version).toBe(5);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
  } finally {
    fixture.engine.dispose();
  }
});

it("keeps a newer local edit when the deferred peer version is reconciled", async () => {
  const fixture = await createDeliveryFixture();
  const finishEditing = trackLocalInteraction(fixture);
  try {
    await deferPeerEdit(fixture);
    fixture.draw("shared", 9);
    await finishEditing();
    expect(fixture.api.getSceneElementsIncludingDeleted()[0]?.version).toBe(9);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.submitUpdate.mock.calls[1]?.[0].elements[0]?.version).toBe(9);
  } finally {
    fixture.engine.dispose();
  }
});

it("discards deferred peer edits when the scene is cleared", async () => {
  const fixture = await createDeliveryFixture();
  const finishEditing = trackLocalInteraction(fixture);
  try {
    await deferPeerEdit(fixture);
    fixture.engine.handleRemoteSnapshot({ sceneId: "cleared", elements: [] });
    await finishEditing();
    expect(fixture.api.getSceneElementsIncludingDeleted()).toEqual([]);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
  } finally {
    fixture.engine.dispose();
  }
});

async function acknowledgeFirstCommit(pending: ReturnType<typeof deferredCommit>) {
  pending.resolve({ operationId: "first", sceneId: "scene", revision: "1" });
  await vi.advanceTimersByTimeAsync(0);
}

async function deferPeerEdit(fixture: Awaited<ReturnType<typeof createDeliveryFixture>>) {
  fixture.draw("shared", 1);
  await vi.advanceTimersByTimeAsync(150);
  fixture.draw("shared", 2);
  fixture.engine.handleRemoteData({ sceneId: "scene", syncAll: false, elements: fixture.make("shared", 5).map(fixture.toWireElement) });
}

function trackLocalInteraction(fixture: Awaited<ReturnType<typeof createDeliveryFixture>>, interaction = "drawing") {
  const getAppState = fixture.api.getAppState;
  let editing = true;
  fixture.api.getAppState = () => ({
    ...getAppState(),
    newElement: editing && interaction === "drawing" ? (fixture.api.getSceneElementsIncludingDeleted()[0] ?? null) : null,
    resizingElement: editing && interaction === "resizing" ? (fixture.api.getSceneElementsIncludingDeleted()[0] ?? null) : null,
  });
  return async () => {
    editing = false;
    fixture.canvasChange();
    await vi.advanceTimersByTimeAsync(150);
  };
}

async function createDeliveryFixture() {
  const { restoreAppState, restoreElements } = await import("@excalidraw/excalidraw");
  const { ExcalidrawCollabEngine } = await import("./engine");
  const { toWireElement } = await import("./wire");
  vi.useFakeTimers();
  const pointerUps: (() => void)[] = [];
  const api = createCanvas(restoreElements, restoreAppState, pointerUps);
  const make = (id: string, version: number, versionNonce = version) =>
    restoreElements(
      [
        {
          type: "freedraw",
          id,
          index: "a0",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          points: [
            [0, 0],
            [100, 100],
          ],
          pressures: [],
          simulatePressure: true,
          version,
          versionNonce,
          isDeleted: false,
        },
      ],
      null,
    );
  const submitUpdate = vi.fn(async (input: Parameters<import("./engine").ExcalidrawCollabEngineOptions["submitUpdate"]>[0]) => ({ operationId: "operation", sceneId: input.sceneId, revision: "1" }));
  const onSubmissionError = vi.fn();
  const engine = new ExcalidrawCollabEngine({ excalidrawAPI: api, canDraw: true, submitUpdate, sendCursor: vi.fn(), requestSnapshot: async () => undefined, clear: vi.fn(), subscribe: () => () => undefined, onSubmissionError });
  engine.handleRemoteSnapshot({ sceneId: "scene", elements: [] });
  const draw = (id: string, version: number, versionNonce = version) => {
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted().filter((element) => element.id !== id), ...make(id, version, versionNonce)] });
    engine.handleChange(api.getSceneElementsIncludingDeleted(), api.getAppState(), {});
  };
  const pointerUp = () => pointerUps.forEach((fire) => fire());
  const canvasChange = () => engine.handleChange(api.getSceneElementsIncludingDeleted(), api.getAppState(), {});
  return { api, engine, submitUpdate, onSubmissionError, make, draw, pointerUp, canvasChange, toWireElement };
}

it("does not back off a new scene when a submission from the previous scene fails", async () => {
  const fixture = await createDeliveryFixture();
  const pending = deferredCommit();
  fixture.submitUpdate.mockImplementationOnce(() => pending.promise);
  try {
    fixture.draw("old", 1);
    await vi.advanceTimersByTimeAsync(150);
    fixture.engine.handleRemoteSnapshot({ sceneId: "replacement", elements: [] });
    fixture.draw("new", 1);
    await vi.advanceTimersByTimeAsync(150);
    pending.reject(new Error("storage_unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.submitUpdate).toHaveBeenCalledTimes(2);
    expect(fixture.submitUpdate.mock.calls[1]?.[0].sceneId).toBe("replacement");
    expect(fixture.submitUpdate.mock.calls[1]?.[0].elements.map((element) => element.id)).toEqual(["new"]);
  } finally {
    fixture.engine.dispose();
  }
});

function deferredCommit() {
  let resolve: (commit: import("./wire").WhiteboardCommit) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<import("./wire").WhiteboardCommit>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it.each(["oversized payload", "unserializable payload"])("isolates an element with an %s and reports it once until it can be sent", async (kind) => {
  const fixture = await createDeliveryFixture();
  const conversion = vi.spyOn(await import("./wire"), "toFittedWireElement");
  const [base] = fixture.make("refused", 1);
  if (!base) throw new Error("Missing refused element fixture");
  const customData = kind === "oversized payload" ? { note: "界".repeat(16_384) } : { note: Number.NaN };
  const bad = { ...base, customData };
  try {
    fixture.api.updateScene({ elements: [bad, ...fixture.make("first", 1)] });
    fixture.canvasChange();
    await vi.advanceTimersByTimeAsync(150);
    expect(fixture.submitUpdate).toHaveBeenCalledOnce();
    expect(fixture.submitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ elements: [expect.objectContaining({ id: "first" })] }));
    expect(fixture.onSubmissionError).toHaveBeenCalledOnce();
    fixture.engine.handleRemoteSnapshot({ sceneId: "scene", elements: [] });
    fixture.draw("later", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.onSubmissionError).toHaveBeenCalledOnce();
    expect(conversion.mock.calls.filter(([element]) => element.id === bad.id)).toHaveLength(1);
    expect(fixture.submitUpdate.mock.calls.flatMap(([input]) => input.elements).some((element) => element.id === "later")).toBe(true);
    // A new nonce alone is a new version: it is tried again, and the writer is not told again.
    fixture.api.updateScene({ elements: [{ ...bad, versionNonce: 99 }, ...fixture.api.getSceneElementsIncludingDeleted().filter((element) => element.id !== bad.id)] });
    fixture.canvasChange();
    await vi.advanceTimersByTimeAsync(150);
    expect(conversion.mock.calls.filter(([element]) => element.id === bad.id)).toHaveLength(2);
    fixture.api.updateScene({ elements: [{ ...bad, version: 2 }, ...fixture.api.getSceneElementsIncludingDeleted().filter((element) => element.id !== bad.id)] });
    fixture.canvasChange();
    await vi.advanceTimersByTimeAsync(150);
    expect(conversion.mock.calls.filter(([element]) => element.id === bad.id)).toHaveLength(3);
    expect(fixture.onSubmissionError).toHaveBeenCalledOnce();
    expect(fixture.onSubmissionError).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.not.stringContaining(bad.id) }));
    fixture.api.updateScene({ elements: [{ ...bad, version: 3, customData: {} }, ...fixture.api.getSceneElementsIncludingDeleted().filter((element) => element.id !== bad.id)] });
    fixture.canvasChange();
    await vi.advanceTimersByTimeAsync(150);
    expect(fixture.submitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ elements: [expect.objectContaining({ id: "refused", version: 3 })] }));
    fixture.api.updateScene({ elements: [{ ...bad, version: 4 }, ...fixture.make("final", 1)] });
    fixture.canvasChange();
    fixture.engine.dispose();
    expect(fixture.submitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ elements: [expect.objectContaining({ id: "final" })] }));
    // It had become sendable in between, so the new refusal is reported.
    expect(fixture.onSubmissionError).toHaveBeenCalledTimes(2);
  } finally {
    fixture.engine.dispose();
    conversion.mockRestore();
  }
});

it("does not submit or retry a delta with only an unfit element", async () => {
  const fixture = await createDeliveryFixture();
  const [base] = fixture.make("refused", 1);
  if (!base) throw new Error("Missing refused element fixture");
  try {
    fixture.api.updateScene({ elements: [{ ...base, customData: { note: "界".repeat(16_384) } }] });
    fixture.canvasChange();
    await vi.advanceTimersByTimeAsync(30_000);
    fixture.pointerUp();
    fixture.canvasChange();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.submitUpdate).not.toHaveBeenCalled();
    expect(fixture.onSubmissionError).toHaveBeenCalledOnce();
  } finally {
    fixture.engine.dispose();
  }
});

it("submits a stroke over the element size as a reduced copy and keeps the full stroke on the writer's canvas", async () => {
  const fixture = await createDeliveryFixture();
  const [base] = fixture.make("long", 1);
  if (!base || base.type !== "freedraw") throw new Error("Missing long stroke fixture");
  const points = Array.from({ length: 4000 }, (_, index) => [index / 10 + 0.123456, Math.sin(index / 50) * 100 + 0.654321] as [number, number]);
  try {
    fixture.api.updateScene({ elements: [{ ...base, points, pressures: points.map(() => 0.5), simulatePressure: false }] });
    fixture.canvasChange();
    fixture.pointerUp();
    await vi.advanceTimersByTimeAsync(0);
    fixture.draw("after", 1);
    fixture.pointerUp();
    await vi.advanceTimersByTimeAsync(150);
    const submitted = fixture.submitUpdate.mock.calls.flatMap(([input]) => input.elements);
    const long = submitted.find((element) => element.id === "long");
    const sent = long?.payload.points;
    if (!Array.isArray(sent)) throw new Error("The long stroke was not submitted");
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.length).toBeLessThan(points.length);
    expect(new TextEncoder().encode(JSON.stringify(long)).byteLength).toBeLessThanOrEqual(16_384 - 64);
    expect(submitted.some((element) => element.id === "after")).toBe(true);
    expect(fixture.onSubmissionError).not.toHaveBeenCalled();
    const local = fixture.api.getSceneElementsIncludingDeleted().find((element) => element.id === "long");
    expect(local && "points" in local ? local.points : []).toHaveLength(points.length);
  } finally {
    fixture.engine.dispose();
  }
});

it("keeps the order keys of a board that arrives in another order than the keys", async () => {
  const fixture = await createDeliveryFixture();
  const keyed = (id: string, index: string) => {
    const [element] = fixture.make(id, 1);
    if (!element) throw new Error("Missing keyed fixture");
    return { ...element, index: index as typeof element.index };
  };
  // Sync lists a board by order key in its database's collation: "aa" comes before "aA" there, after it in the keys' own order.
  const board = [keyed("second", "aa"), keyed("first", "aA"), keyed("third", "ab")];
  try {
    fixture.engine.handleRemoteSnapshot({ sceneId: "scene", elements: board.map(fixture.toWireElement) });
    await vi.advanceTimersByTimeAsync(1_000);
    const scene = fixture.api.getSceneElementsIncludingDeleted();
    expect(scene.map((element) => [element.id, element.index, element.version])).toEqual([
      ["first", "aA", 1],
      ["second", "aa", 1],
      ["third", "ab", 1],
    ]);
    expect(fixture.submitUpdate).not.toHaveBeenCalled();
  } finally {
    fixture.engine.dispose();
  }
});

it("strips imported image bytes while retaining stored images and new drawings", async () => {
  const { restoreAppState, restoreElements } = await import("@excalidraw/excalidraw");
  const { ExcalidrawCollabEngine } = await import("./engine");
  const { toWireElement } = await import("./wire");
  vi.useFakeTimers();
  const api = createCanvas(restoreElements, restoreAppState);
  const stored = restoreElements([{ type: "image", id: "stored-image", fileId: "stored-file", status: "saved", x: 0, y: 0, width: 100, height: 100, version: 1, versionNonce: 1 }], null);
  const imported = restoreElements([{ type: "image", id: "imported-image", fileId: "unstored-file", status: "saved", x: 100, y: 0, width: 100, height: 100, version: 1, versionNonce: 1 }], null);
  const drawing = restoreElements([{ type: "rectangle", id: "new-drawing", x: 0, y: 100, width: 100, height: 100, version: 1, versionNonce: 1 }], null);
  const submitUpdate = vi.fn(async (input: { sceneId: string }) => ({ operationId: "operation", sceneId: input.sceneId, revision: "2" }));
  const engine = new ExcalidrawCollabEngine({ excalidrawAPI: api, canDraw: true, submitUpdate, sendCursor: vi.fn(), requestSnapshot: async () => undefined, clear: vi.fn(), subscribe: () => () => undefined });
  try {
    engine.handleRemoteSnapshot({ sceneId: "scene", elements: stored.map(toWireElement) });
    api.updateScene({ elements: [...stored, ...imported, ...drawing] });
    engine.handleChange(api.getSceneElementsIncludingDeleted(), restoreAppState({}, null), {});
    expect(api.getSceneElementsIncludingDeleted().map((element) => element.id)).toEqual(["stored-image", "new-drawing"]);
    await vi.advanceTimersByTimeAsync(150);
    expect(submitUpdate).toHaveBeenCalledOnce();
    expect(submitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ elements: [expect.objectContaining({ id: "new-drawing" })] }));
  } finally {
    engine.dispose();
  }
});

it("clears engine history only after a local shared clear commits", async () => {
  const { restoreAppState, restoreElements } = await import("@excalidraw/excalidraw");
  const { ExcalidrawCollabEngine } = await import("./engine");
  const api = createCanvas(restoreElements, restoreAppState);
  const clear = vi.fn().mockRejectedValueOnce(new Error("clear failed")).mockResolvedValueOnce({ sceneId: "new-scene", revision: "1" });
  const engine = new ExcalidrawCollabEngine({ excalidrawAPI: api, canDraw: true, submitUpdate: vi.fn(), sendCursor: vi.fn(), requestSnapshot: vi.fn(), clear, subscribe: () => () => undefined });
  try {
    await expect(engine.clear()).rejects.toThrow("clear failed");
    expect(api.history.clear).not.toHaveBeenCalled();
    await engine.clear();
    expect(api.history.clear).toHaveBeenCalledOnce();
  } finally {
    engine.dispose();
  }
});

it.each([false, true])("uses explicit management authority %s independently of drawing", async (canManage) => {
  const { engine } = await createReconciliationFixture({ canDraw: !canManage, canManage });
  try {
    if (canManage) await expect(engine.clear()).resolves.toEqual(expect.objectContaining({ sceneId: "cleared" }));
    else await expect(engine.clear()).rejects.toThrow("management");
  } finally {
    engine.dispose();
  }
});

it("retires surface-coloured undo and redo history when ink changes", async () => {
  const { api, engine } = await createReconciliationFixture({ inkColor: "#f1f0ea" });
  try {
    engine.setInkColor("#1b1c1f");
    expect(api.history.clear).toHaveBeenCalledOnce();
    engine.setInkColor("#1b1c1f");
    expect(api.history.clear).toHaveBeenCalledOnce();
  } finally {
    engine.dispose();
  }
});
