import { describe, expect, it } from "vitest";

import { ClassicScreenShareView } from "./ClassicScreenShareView";

describe("ClassicScreenShareView", () => {
  it("exports the classic renderer", () => {
    expect(ClassicScreenShareView).toBeDefined();
  });
});
