import { describe, expect, it } from "vitest";

import { ClassicChatPanel } from "./ClassicChatPanel";

describe("ClassicChatPanel", () => {
  it("exports the classic renderer", () => {
    expect(ClassicChatPanel).toBeDefined();
  });
});
