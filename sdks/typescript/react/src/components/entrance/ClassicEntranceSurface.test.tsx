import { describe, expect, it } from "vitest";

import { ClassicEntranceSurface } from "./ClassicEntranceSurface";

describe("ClassicEntranceSurface", () => {
  it("exports the internal renderer", () => {
    expect(ClassicEntranceSurface).toBeDefined();
  });
});
