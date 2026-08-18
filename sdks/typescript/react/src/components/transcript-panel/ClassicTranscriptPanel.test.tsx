import { describe, expect, it } from "vitest";

import { ClassicTranscriptPanel } from "./ClassicTranscriptPanel";

describe("ClassicTranscriptPanel", () => {
  it("exports the classic renderer", () => {
    expect(ClassicTranscriptPanel).toBeDefined();
  });
});
