import { describe, expect, it } from "vitest";
import { choosePrimary, floatingSpeakerId, speakingParticipantId, type StageItem, type PrimaryContext } from "./stage-items";
import { DEFAULT_GRID_OPTIONS, DEFAULT_SPOTLIGHT_OPTIONS, fitGrid, fitSpotlight, MORE_TILE_ID } from "./stage-layout";

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
  it("keeps the first share large until selected or stopped", () => {
    const newer: StageItem = { ...share, id: "screen-share:newer" };
    expect(
      choosePrimary([person, share, newer], {
        ...context,
        seenAt: new Map([
          [share.id, 1],
          [newer.id, 2],
        ]),
      }),
    ).toBe(share);
    expect(choosePrimary([person, share, newer], { ...context, pinnedId: newer.id })).toBe(newer);
    expect(choosePrimary([person, newer], context)).toBe(newer);
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
  it.each([3, 5, 7, 12])("fills all rows for %i people without holes", (count) => {
    const box = { width: 1408, height: 756 };
    const geometry = fitGrid(
      box,
      Array.from({ length: count }, (_, index) => String(index)),
      DEFAULT_GRID_OPTIONS,
    );
    const rows = Array.from(new Set(geometry.frames.map((frame) => frame.y)), (y) => geometry.frames.filter((frame) => frame.y === y));
    let coveredHeight = 0;
    for (const frames of rows.values()) {
      expect(frames[0]?.x).toBeCloseTo(0);
      let edge = 0;
      for (const frame of frames) {
        expect(frame.x).toBeCloseTo(edge);
        edge = frame.x + frame.width + 8;
      }
      expect(edge - 8).toBeCloseTo(box.width);
      coveredHeight += frames[0]?.height ?? 0;
    }
    expect(coveredHeight + (rows.length - 1) * 8).toBeCloseTo(box.height);
  });
  it("gives content two real units, without overlapping its neighbor", () => {
    const geometry = fitGrid({ width: 1408, height: 756 }, ["whiteboard", "a", "b", "c", "d"], DEFAULT_GRID_OPTIONS, ["whiteboard"]);
    const board = geometry.frames.find((frame) => frame.id === "whiteboard");
    const neighbor = geometry.frames.find((frame) => frame.id === "a");
    expect(board?.width).toBeCloseTo((neighbor?.width ?? 0) * 2 + 8);
    expect(neighbor?.x).toBeCloseTo((board?.width ?? 0) + 8);
  });
});

it("lets a phone board fill its allotted area instead of forcing a video aspect", () => {
  const box = { width: 358, height: 692 };
  const geometry = fitSpotlight(box, "whiteboard", ["a", "b", "c", "d", "e", "f"], { ...DEFAULT_SPOTLIGHT_OPTIONS, content: true, primaryAspect: null });
  const board = geometry.frames[0];
  expect(board?.width).toBe(box.width);
  expect(board?.height).toBe(box.height - Math.round(box.height * 0.3) - 8);
});

describe("a board on a phone", () => {
  const box = { width: 358, height: 692 };
  const options = { ...DEFAULT_SPOTLIGHT_OPTIONS, content: true, primaryAspect: null, floatingPhonePeople: true, speakerId: "malik", localId: "me" };

  it("keeps the whole stage for the board and floats people at its right edge, speaker first and larger", () => {
    const geometry = fitSpotlight(box, "whiteboard", ["me", "nora", "malik"], options);
    expect(geometry.frames.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))).toEqual([
      { id: "whiteboard", x: 0, y: 0, width: 358, height: 692 },
      { id: "malik", x: 226, y: 56, width: 120, height: 68 },
      { id: "nora", x: 270, y: 132, width: 76, height: 44 },
      { id: "me", x: 270, y: 184, width: 76, height: 44 },
    ]);
  });

  it("shows the speaker and the local person, then folds everyone else into a +N tile", () => {
    const geometry = fitSpotlight(box, "whiteboard", ["me", "nora", "malik", "akash", "sofia"], options);
    expect(geometry.frames.map((frame) => frame.id)).toEqual(["whiteboard", "malik", "me", MORE_TILE_ID]);
    expect(geometry.overflowCount).toBe(3);
  });

  it("floats shared content above the faces and never folds it into +N", () => {
    const geometry = fitSpotlight(box, "whiteboard", ["share", "me", "nora", "malik", "akash"], { ...options, wideIds: ["whiteboard", "share"] });
    expect(geometry.frames.map((frame) => frame.id)).toEqual(["whiteboard", "share", "malik", "me", MORE_TILE_ID]);
    expect(geometry.overflowCount).toBe(2);
  });

  it("keeps fewer faces on a short stage so the column stays over the board", () => {
    const short = { width: 608, height: 202 };
    const geometry = fitSpotlight(short, "whiteboard", ["me", "nora", "malik"], options);
    const last = geometry.frames.at(-1);
    expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(short.height - 8);
    expect(geometry.frames.map((frame) => frame.id)).toEqual(["whiteboard", "me", MORE_TILE_ID]);
  });

  it("starts a new column instead of running content past the bottom of a short stage", () => {
    const short = { width: 608, height: 162 };
    const geometry = fitSpotlight(short, "whiteboard", ["share", "me", "nora", "malik"], { ...options, wideIds: ["whiteboard", "share"] });
    expect(geometry.frames.map((frame) => frame.id)).toEqual(["whiteboard", "share", MORE_TILE_ID]);
    for (const frame of geometry.frames.slice(1)) expect(frame.y + frame.height).toBeLessThanOrEqual(short.height - 8);
    expect(geometry.frames[2]?.x).toBe(608 - 12 - 120 - 8 - 76);
  });

  it("honours the visible-tile limit", () => {
    const geometry = fitSpotlight(box, "whiteboard", ["me", "nora", "malik"], { ...options, maxPerPage: 2 });
    expect(geometry.frames.map((frame) => frame.id)).toEqual(["whiteboard", "me", MORE_TILE_ID]);
    expect(geometry.overflowCount).toBe(2);
  });
});

it("leads the floating faces with the active speaker before anyone else speaking", () => {
  const remote = (id: string, flags: { isActiveSpeaker?: boolean; isSpeaking?: boolean }): StageItem => ({ kind: "participant", id, participant: { id, displayName: id, ...flags } });
  const items = [remote("nora", { isSpeaking: true }), remote("malik", { isActiveSpeaker: true, isSpeaking: true })];
  expect(floatingSpeakerId(items, null)).toBe("malik");
  expect(speakingParticipantId(items)).toBe("malik");
  expect(floatingSpeakerId([remote("nora", {})], "akash")).toBe("akash");
});
