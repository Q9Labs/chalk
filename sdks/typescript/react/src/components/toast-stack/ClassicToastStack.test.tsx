import { describe, expect, it } from "vitest";

import { ClassicToastStack } from "./ClassicToastStack";

describe("ClassicToastStack", () => {
  it("exports the classic renderer", () => {
    expect(ClassicToastStack).toBeDefined();
  });
});
