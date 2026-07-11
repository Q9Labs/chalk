import { describe, expect, it, vi } from "vitest";

import { createMathImageAsset, getChalkMathData, getSelectedMathElement, isChalkMathElement, svgToDataUrl } from "@q9labsai/chalk-whiteboard/react";

describe("whiteboard math elements", () => {
  it("encodes SVG as an Excalidraw data URL", () => {
    const dataUrl = svgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>π</text></svg>');

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/u);
  });

  it("stores editable LaTeX metadata on math image assets", () => {
    const asset = createMathImageAsset({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" />',
      width: 180,
      height: 80,
      latex: String.raw`\frac{a}{b}`,
      displayMode: true,
    });

    const element = {
      type: "image",
      customData: asset.customData,
    };

    expect(asset.file.mimeType).toBe("image/svg+xml");
    expect(getChalkMathData(element as never)).toEqual({
      kind: "math",
      latex: String.raw`\frac{a}{b}`,
      renderer: "mathjax-svg",
      version: 1,
      displayMode: true,
    });
    expect(isChalkMathElement(element as never)).toBe(true);
  });

  it("finds the selected math image element", () => {
    const mathElement = {
      id: "math-1",
      type: "image",
      customData: {
        chalk: {
          kind: "math",
          latex: "x^2",
        },
      },
    };
    const api = {
      getAppState: vi.fn(() => ({ selectedElementIds: { "math-1": true } })),
      getSceneElements: vi.fn(() => [mathElement]),
    };

    expect(getSelectedMathElement(api as never)).toBe(mathElement);
  });
});
