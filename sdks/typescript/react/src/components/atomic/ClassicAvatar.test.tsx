import { describe, expect, it } from "vitest";

import { ClassicAvatar } from "./ClassicAvatar";

describe("ClassicAvatar", () => {
  it("exports the classic renderer", () => {
    expect(ClassicAvatar).toBeDefined();
  });
});
