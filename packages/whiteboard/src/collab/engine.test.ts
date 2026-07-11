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
import type { ExcalidrawImperativeAPI, OrderedExcalidrawElement } from "./types";

const createElement = (id: string, version: number, hash: number) =>
  ({
    id,
    version,
    hash,
    isDeleted: false,
    updated: Date.now(),
  }) as unknown as OrderedExcalidrawElement & { hash: number };

describe("ExcalidrawCollabEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("broadcasts changed elements when the new hash is numerically lower", () => {
    const remoteElements = [createElement("remote", 1, 100)];
    const localElements = [createElement("local", 1, 50)];
    let sceneElements: readonly OrderedExcalidrawElement[] = remoteElements;

    const api = {
      addFiles: vi.fn(),
      getAppState: vi.fn(() => ({})),
      getFiles: vi.fn(() => ({})),
      getSceneElementsIncludingDeleted: vi.fn(() => sceneElements),
      onPointerUp: vi.fn(() => vi.fn()),
      updateScene: vi.fn(),
    } as unknown as ExcalidrawImperativeAPI;
    const sendUpdateV2 = vi.fn();

    const engine = new ExcalidrawCollabEngine({
      excalidrawAPI: api,
      canDraw: true,
      sendUpdateV2,
      sendCursor: vi.fn(),
      requestSync: vi.fn(),
      presignUpload: vi.fn(),
      presignDownload: vi.fn(),
    });

    engine.handleRemoteSnapshot({ sceneId: "scene-1", elements: remoteElements });
    sceneElements = localElements;
    engine.handleChange(localElements, {} as never, {});
    vi.advanceTimersByTime(151);

    expect(sendUpdateV2).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: localElements,
        sceneId: "scene-1",
        syncAll: false,
      }),
    );

    engine.dispose();
  });
});
