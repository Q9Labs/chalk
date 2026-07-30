import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const excalidrawMocks = vi.hoisted(() => ({
  hashElementsVersion: vi.fn((elements: ReadonlyArray<{ hash?: number }>) => elements.reduce((hash, element) => hash + (element.hash ?? 0), 0)),
  reconcileElements: vi.fn((_local: unknown, remote: unknown) => remote),
  restoreElements: vi.fn((remote: unknown) => remote),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "NEVER" },
  hashElementsVersion: excalidrawMocks.hashElementsVersion,
  isInvisiblySmallElement: () => false,
  reconcileElements: excalidrawMocks.reconcileElements,
  restoreElements: excalidrawMocks.restoreElements,
}));

import { ExcalidrawCollabEngine } from "./engine";
import type { ExcalidrawCollabEngineOptions } from "./engine";
import type { ExcalidrawImperativeAPI, OrderedExcalidrawElement } from "./types";
import { toWireElement } from "./wire";

const createElement = (id: string, version: number, hash: number) =>
  ({
    id,
    type: "rectangle",
    version,
    versionNonce: version * 10,
    index: `a${version}`,
    hash,
    isDeleted: false,
    updated: Date.now(),
  }) as unknown as OrderedExcalidrawElement & { hash: number };

const createAPI = (elements: () => readonly OrderedExcalidrawElement[]) =>
  ({
    addFiles: vi.fn(),
    getAppState: vi.fn(() => ({})),
    getFiles: vi.fn(() => ({})),
    getSceneElementsIncludingDeleted: vi.fn(elements),
    onPointerUp: vi.fn(() => vi.fn()),
    updateScene: vi.fn(),
  }) as unknown as ExcalidrawImperativeAPI;

const createEngine = (excalidrawAPI: ExcalidrawImperativeAPI, overrides: Partial<Omit<ExcalidrawCollabEngineOptions, "excalidrawAPI">> = {}) =>
  new ExcalidrawCollabEngine({
    excalidrawAPI,
    canDraw: true,
    submitUpdate: vi.fn(),
    sendCursor: vi.fn(),
    requestSnapshot: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
    initiateUpload: vi.fn(),
    finalizeUpload: vi.fn(),
    presignDownload: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    ...overrides,
  });

describe("ExcalidrawCollabEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("submits changed elements when the new hash is numerically lower", async () => {
    const remoteElements = [createElement("remote", 1, 100)];
    const localElements = [createElement("local", 1, 50)];
    let sceneElements: readonly OrderedExcalidrawElement[] = remoteElements;

    const api = createAPI(() => sceneElements);
    const submitUpdate = vi.fn().mockResolvedValue({
      operationId: "operation-0000000001",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "2",
    });

    const engine = createEngine(api, {
      submitUpdate,
    });

    engine.handleRemoteSnapshot({
      sceneId: "10000000-0000-4000-8000-000000000001",
      sceneGeneration: "scene-generation-1",
      elements: remoteElements.map(toWireElement),
    });
    sceneElements = localElements;
    engine.handleChange(localElements, {} as never, {});
    await vi.advanceTimersByTimeAsync(151);

    expect(submitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: localElements.map(toWireElement),
        sceneId: "10000000-0000-4000-8000-000000000001",
        sceneGeneration: "scene-generation-1",
        syncAll: false,
      }),
    );

    engine.dispose();
  });

  it("does not infer an epoch clear when the canvas becomes empty", async () => {
    const original = [createElement("local", 1, 50)];
    const tombstone = [{ ...original[0], isDeleted: true, version: 2, hash: 60 }] as unknown as OrderedExcalidrawElement[];
    let sceneElements: readonly OrderedExcalidrawElement[] = original;
    const api = createAPI(() => sceneElements);
    const clear = vi.fn();
    const submitUpdate = vi.fn().mockResolvedValue({
      operationId: "operation-0000000001",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "2",
    });
    const engine = createEngine(api, {
      submitUpdate,
      clear,
    });

    engine.handleRemoteSnapshot({
      sceneId: "10000000-0000-4000-8000-000000000001",
      elements: original.map(toWireElement),
    });
    sceneElements = tombstone;
    engine.handleChange(tombstone, {} as never, {});
    await vi.advanceTimersByTimeAsync(151);

    expect(clear).not.toHaveBeenCalled();
    expect(submitUpdate).toHaveBeenCalledWith(expect.objectContaining({ elements: tombstone.map(toWireElement) }));
    engine.dispose();
  });

  it("routes subscribed transport snapshots and resets into the engine", () => {
    const api = createAPI(() => []);
    const requestSnapshot = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn();
    let listener: Parameters<NonNullable<ConstructorParameters<typeof ExcalidrawCollabEngine>[0]["subscribe"]>>[0] | undefined;
    const remote = [createElement("remote", 1, 10)];
    const engine = createEngine(api, {
      requestSnapshot,
      subscribe: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
    });

    listener?.({
      type: "snapshot",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "3",
      elements: remote.map(toWireElement),
      appState: { viewBackgroundColor: "#fff" },
    });
    expect(api.updateScene).toHaveBeenCalledWith(expect.objectContaining({ elements: remote }));

    listener?.({
      type: "reset_required",
      sceneId: "10000000-0000-4000-8000-000000000002",
      reason: "scene_changed",
    });
    expect(requestSnapshot).toHaveBeenCalledOnce();

    engine.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
