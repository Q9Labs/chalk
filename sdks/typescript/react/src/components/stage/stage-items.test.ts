import { describe, expect, it } from "vitest";
import { choosePrimary, type StageItem, type PrimaryContext } from "./stage-items";
import { DEFAULT_GRID_OPTIONS, fitGrid } from "./stage-layout";

const person: StageItem = { kind: "participant", id: "person", participant: { id: "person", displayName: "Nora", isActiveSpeaker: true } };
const board: StageItem = { kind: "whiteboard", id: "whiteboard" };
const share: StageItem = { kind: "screen-share", id: "screen-share:person", participant: person.participant };
const context: PrimaryContext = { layout: "focus", pinnedId: null, lastSpeakerId: null, seenAt: new Map([[share.id, 1]]) };

describe("Spotlight primary content", () => {
  it("keeps shared content ahead of a speaking or pinned person", () => {
    expect(choosePrimary([person, board], context)).toBe(board);
    expect(choosePrimary([person, board], { ...context, pinnedId: person.id })).toBe(board);
  });
  it("prefers a screen share over the board unless the board was selected", () => {
    expect(choosePrimary([person, board, share], context)).toBe(share);
    expect(choosePrimary([person, board, share], { ...context, pinnedId: board.id })).toBe(board);
  });
  it("chooses the newest screen share and falls back when it ends", () => {
    const newer: StageItem = { ...share, id: "screen-share:newer" };
    expect(
      choosePrimary([person, share, newer], {
        ...context,
        seenAt: new Map([
          [share.id, 1],
          [newer.id, 2],
        ]),
      }),
    ).toBe(newer);
    expect(choosePrimary([person, board], { ...context, pinnedId: share.id })).toBe(board);
    expect(choosePrimary([person], { ...context, pinnedId: board.id })).toBe(person);
  });
  it("uses the pinned person before the speaker when no content exists", () => {
    const pinned: StageItem = { kind: "participant", id: "pinned", participant: { id: "pinned", displayName: "Akash" } };
    expect(choosePrimary([person, pinned], { ...context, pinnedId: pinned.id })).toBe(pinned);
    expect(choosePrimary([person, pinned], context)).toBe(person);
    expect(choosePrimary([], context)).toBeNull();
  });
});

describe("Grid shared-content room", () => {
  it("lets a lone content tile use spare columns without displacing people", () => {
    const box = { width: 1000, height: 700 };
    const ids = ["a", "b", "whiteboard"];
    const equal = fitGrid(box, ids, DEFAULT_GRID_OPTIONS);
    const expanded = fitGrid(box, ids, DEFAULT_GRID_OPTIONS, ["whiteboard"]);
    const content = expanded.frames.find((frame) => frame.id === "whiteboard")!;
    expect(content.width).toBeGreaterThan(equal.frames.find((frame) => frame.id === "whiteboard")!.width);
    expect(expanded.frames.filter((frame) => frame.id !== "whiteboard")).toEqual(equal.frames.filter((frame) => frame.id !== "whiteboard"));
    expect(content.x).toBeGreaterThanOrEqual(0);
    expect(content.x + content.width).toBeLessThanOrEqual(box.width);
  });
});
