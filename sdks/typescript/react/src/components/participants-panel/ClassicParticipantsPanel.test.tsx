import { describe, expect, it } from "vitest";

import { ClassicParticipantsPanel } from "./ClassicParticipantsPanel";

describe("ClassicParticipantsPanel", () => {
  it("exports the classic renderer", () => {
    expect(ClassicParticipantsPanel).toBeDefined();
  });
});
