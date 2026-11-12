import { describe, expect, it } from "vitest";
import { CANONICAL_INK } from "../../collab/ink";
import { checkInk, strokeChip } from "./board-model";

describe("stroke chip", () => {
  it("shows Ink as the surface's own ink, so the disc is never invisible", () => {
    expect(strokeChip("ink", "medium", "chalkboard", "dark").disc).toBe("#f1f0ea");
    expect(strokeChip("ink", "medium", "paper", "light").disc).toBe(CANONICAL_INK);
  });
});

describe("stroke popover", () => {
  it("puts a dark mark in a light colour and a light mark in a dark one", () => {
    expect(checkInk("#f1f0ea")).toBe("#111111");
    expect(checkInk(CANONICAL_INK)).toBe("#ffffff");
    expect(checkInk("#e23240")).toBe("#ffffff");
  });
});
