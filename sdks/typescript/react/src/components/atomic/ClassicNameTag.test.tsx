import { describe, expect, it } from "vitest";

import { ClassicNameTag } from "./ClassicNameTag";

describe("ClassicNameTag", () => {
  it("exports the classic renderer", () => {
    expect(ClassicNameTag).toBeDefined();
  });
});
