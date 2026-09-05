import { describe, expect, it } from "vitest";

import { createEmbeddedWhiteboardViewport } from "./embedded-whiteboard-viewport";

describe("native embedded whiteboard viewport", () => {
  it("uses the measured Board rectangle rather than the device window", () => {
    expect(createEmbeddedWhiteboardViewport(640, 420, 2)).toEqual({ width: 640, height: 420, scale: 2 });
  });

  it("waits for a usable layout", () => {
    expect(createEmbeddedWhiteboardViewport(0, 420, 2)).toBeNull();
  });
});
