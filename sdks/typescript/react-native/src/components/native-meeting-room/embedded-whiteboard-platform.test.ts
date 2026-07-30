import { describe, expect, it } from "vitest";
import { withoutEmbeddedWhiteboard } from "./embedded-whiteboard-platform";

describe("withoutEmbeddedWhiteboard", () => {
  it("disables only the unsupported embedded whiteboard feature", () => {
    expect(withoutEmbeddedWhiteboard({ chat: true, whiteboard: true })).toEqual({
      chat: true,
      whiteboard: false,
    });
    expect(withoutEmbeddedWhiteboard(undefined)).toEqual({ whiteboard: false });
  });
});
