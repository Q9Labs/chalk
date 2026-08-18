import { describe, expect, it } from "vitest";

import { ClassicParticipantRow } from "./ClassicParticipantRow";

describe("ClassicParticipantRow", () => {
  it("exports the classic renderer", () => {
    expect(ClassicParticipantRow).toBeDefined();
  });
});
