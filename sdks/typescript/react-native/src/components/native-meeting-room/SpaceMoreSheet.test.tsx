import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SpaceMoreSheet.tsx", import.meta.url), "utf8");

describe("SpaceMoreSheet", () => {
  it("progressively discloses Board, People, Chat, Settings, and Leave", () => {
    for (const label of ['label: controller.whiteboard.isOpen ? "Close Board" : "Board"', 'label: "People"', 'label: "Chat"', 'label: "Settings"', ">Leave<"]) {
      expect(source).toContain(label);
    }
  });
});
