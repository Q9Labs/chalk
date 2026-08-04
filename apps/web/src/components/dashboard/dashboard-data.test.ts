import { describe, expect, it } from "vitest";
import { spaces } from "./dashboard-data";

describe("dashboard fixture model", () => {
  it("models Spaces with explicit current Episode state", () => {
    expect(spaces).toHaveLength(3);
    expect(spaces.some((space) => space.currentEpisode === "In progress")).toBe(true);
    expect(spaces.every((space) => "currentEpisode" in space)).toBe(true);
  });
});
