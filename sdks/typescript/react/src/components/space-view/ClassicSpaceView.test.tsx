import { describe, expect, it } from "vitest";

import { ClassicSpaceView } from "./ClassicSpaceView";

describe("ClassicSpaceView", () => {
  it("exports the classic renderer", () => {
    expect(ClassicSpaceView).toBeDefined();
  });
});
