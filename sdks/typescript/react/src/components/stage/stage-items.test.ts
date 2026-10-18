import { describe, expect, it } from "vitest";
import { choosePrimary, type StageItem, type PrimaryContext } from "./stage-items";
import { DEFAULT_GRID_OPTIONS, fitGrid } from "./stage-layout";

const person: StageItem = { kind: "participant", id: "person", participant: { id: "person", displayName: "Nora", isActiveSpeaker: true } };
const board: StageItem = { kind: "whiteboard", id: "whiteboard" };
const share: StageItem = { kind: "screen-share", id: "screen-share:person", participant: person.participant };
const context: PrimaryContext = { layout: "focus", pinnedId: null, lastSpeakerId: null, seenAt: new Map([[share.id, 1]]) };

describe("Spotlight primary content", () => {
  it("keeps shared content ahead of a speaking person, but honors an explicit pin", () => {
    expect(choosePrimary([person, board], context)).toBe(board);
    expect(choosePrimary([person, board], { ...context, pinnedId: person.id })).toBe(person);
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

describe("Justified rows", () => {
  it.each([3, 5, 7, 12])("fills all rows for %i people without holes", count => {
    const box = { width: 1408, height: 756 };
    const geometry = fitGrid(box, Array.from({ length: count }, (_, index) => String(index)), DEFAULT_GRID_OPTIONS);
    const rows = Array.from(new Set(geometry.frames.map(frame => frame.y)), y => geometry.frames.filter(frame => frame.y === y));
    let coveredHeight = 0;
    for (const frames of rows.values()) {
      expect(frames[0]?.x).toBeCloseTo(0);
      let edge = 0;
      for (const frame of frames) { expect(frame.x).toBeCloseTo(edge); edge = frame.x + frame.width + 8; }
      expect(edge - 8).toBeCloseTo(box.width);
      coveredHeight += frames[0]?.height ?? 0;
    }
    expect(coveredHeight + (rows.length - 1) * 8).toBeCloseTo(box.height);
  });
  it("gives content two real units, without overlapping its neighbor", () => {
    const geometry = fitGrid({ width: 1408, height: 756 }, ["whiteboard", "a", "b", "c", "d"], DEFAULT_GRID_OPTIONS, ["whiteboard"]);
    const board = geometry.frames.find(frame => frame.id === "whiteboard");
    const neighbor = geometry.frames.find(frame => frame.id === "a");
    expect(board?.width).toBeCloseTo((neighbor?.width ?? 0) * 2 + 8);
    expect(neighbor?.x).toBeCloseTo((board?.width ?? 0) + 8);
  });
});
