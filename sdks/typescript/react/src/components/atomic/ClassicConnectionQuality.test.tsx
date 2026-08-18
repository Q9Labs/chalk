import { describe, expect, it } from "vitest";

import { ClassicConnectionQuality } from "./ClassicConnectionQuality";

describe("ClassicConnectionQuality", () => {
  it("exports the classic renderer", () => {
    expect(ClassicConnectionQuality).toBeDefined();
  });
});
