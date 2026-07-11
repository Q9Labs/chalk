import { describe, expect, it, vi } from "vitest";

import { appendOrReplaceMathElement, createMathImageAsset, getInsertionPoint } from "./math-elements";

describe("mathElements", () => {
  it("calculates centered insertion points from the Excalidraw viewport", () => {
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);

    const api = {
      getAppState: () => ({
        scrollX: -100,
        scrollY: -40,
        zoom: { value: 2 },
      }),
    };

    expect(getInsertionPoint(api as never, 200, 100)).toEqual({ x: 250, y: 170 });

    vi.unstubAllGlobals();
  });

  it("appends a math image element and selects it", () => {
    const asset = createMathImageAsset({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" />',
      width: 160,
      height: 80,
      latex: "x^2",
      displayMode: true,
    });
    const createdElement = { id: "new-math", type: "image" };
    const api = {
      addFiles: vi.fn(),
      getAppState: vi.fn(() => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 } })),
      getSceneElementsIncludingDeleted: vi.fn(() => []),
      updateScene: vi.fn(),
    };
    const excalidraw = {
      CaptureUpdateAction: { IMMEDIATELY: "immediately" },
      convertToExcalidrawElements: vi.fn(() => [createdElement]),
      newElementWith: vi.fn(),
    };

    expect(appendOrReplaceMathElement({ api: api as never, excalidraw: excalidraw as never, asset })).toBe(createdElement);
    expect(api.addFiles).toHaveBeenCalledWith([asset.file]);
    expect(api.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: { selectedElementIds: { "new-math": true } },
      }),
    );
  });
});
