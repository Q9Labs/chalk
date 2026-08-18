import { describe, expect, it } from "vitest";

import { ClassicReleaseBadge } from "./ClassicReleaseBadge";

describe("ClassicReleaseBadge", () => {
  it("exports the classic renderer", () => {
    expect(ClassicReleaseBadge).toBeDefined();
  });
});
