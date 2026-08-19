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

  it("flushes a pending local change before disposal", async () => {
    const remoteElements = [createElement("remote", 1, 100)];
    const localElements = [createElement("local", 1, 50)];
    let sceneElements: readonly OrderedExcalidrawElement[] = remoteElements;
    const api = createAPI(() => sceneElements);
    const submitUpdate = vi.fn().mockResolvedValue({
      operationId: "operation-0000000001",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "2",
    });
    const engine = createEngine(api, { submitUpdate });

    engine.handleRemoteSnapshot({
      sceneId: "10000000-0000-4000-8000-000000000001",
      elements: remoteElements.map(toWireElement),
    });
    sceneElements = localElements;
    engine.handleChange(localElements, {} as never, {});

    engine.dispose();

    expect(submitUpdate).toHaveBeenCalledOnce();
    expect(submitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: localElements.map(toWireElement),
        sceneId: "10000000-0000-4000-8000-000000000001",
        syncAll: false,
      }),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(submitUpdate).toHaveBeenCalledOnce();
  });

  it("submits a dirty teardown scene while an earlier submission is in flight", async () => {
    const remoteElements = [createElement("remote", 1, 100)];
    const firstLocalElements = [createElement("first", 1, 50)];
    const finalLocalElements = [createElement("final", 1, 75)];
    let sceneElements: readonly OrderedExcalidrawElement[] = remoteElements;
    const api = createAPI(() => sceneElements);
    const commit = {
      operationId: "operation-0000000001",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "2",
    };
    let resolveFirstSubmission: (value: typeof commit) => void = () => undefined;
    const firstSubmission = new Promise<typeof commit>((resolve) => {
      resolveFirstSubmission = resolve;
    });
    const submitUpdate = vi
      .fn()
      .mockImplementationOnce(() => firstSubmission)
      .mockResolvedValue(commit);
    const engine = createEngine(api, { submitUpdate });

    engine.handleRemoteSnapshot({
      sceneId: commit.sceneId,
      elements: remoteElements.map(toWireElement),
    });
    sceneElements = firstLocalElements;
    engine.handleChange(firstLocalElements, {} as never, {});
    await vi.advanceTimersByTimeAsync(151);

    sceneElements = finalLocalElements;
    engine.handleChange(finalLocalElements, {} as never, {});
    engine.dispose();

    expect(submitUpdate).toHaveBeenCalledTimes(2);
    expect(submitUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        elements: finalLocalElements.map(toWireElement),
        sceneId: commit.sceneId,
        syncAll: false,
      }),
    );

    resolveFirstSubmission(commit);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(submitUpdate).toHaveBeenCalledTimes(2);
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

  it("reports a synchronous snapshot failure instead of throwing from a canvas change", async () => {
    const api = createAPI(() => [createElement("local", 1, 50)]);
    const failure = new Error("Whiteboard is not connected.");
    const onSubmissionError = vi.fn();
    const engine = createEngine(api, {
      requestSnapshot: vi.fn(() => {
        throw failure;
      }),
      onSubmissionError,
    });

    expect(() => engine.handleChange(api.getSceneElementsIncludingDeleted(), {} as never, {})).not.toThrow();
    await vi.advanceTimersByTimeAsync(151);
    expect(onSubmissionError).toHaveBeenCalledWith(failure);
    engine.dispose();
  });

  it("routes subscribed transport snapshots, cursors, and resets into the engine", async () => {
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

    const handleRemoteCursor = vi.spyOn(engine, "handleRemoteCursor");
    listener?.({
      type: "cursor",
      participantId: "participant-1",
      displayName: "Grace",
      x: 24,
      y: 48,
      occurredAt: "2026-08-04T08:00:00.000Z",
    });
    expect(handleRemoteCursor).toHaveBeenCalledWith({
      participantId: "participant-1",
      displayName: "Grace",
      x: 24,
      y: 48,
      timestamp: new Date("2026-08-04T08:00:00.000Z"),
    });

    listener?.({
      type: "reset_required",
      sceneId: "10000000-0000-4000-8000-000000000002",
      reason: "scene_changed",
    });
    await Promise.resolve();
    expect(requestSnapshot).toHaveBeenCalledOnce();

    engine.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
