import { describe, expect, it } from "vitest";
import { nextStageOrder, stageLayout, type StageInput, type StageItem } from "./layout";

// The D1 portrait stage from `frameRegions`. Expected frames come from the mockup's own `layout()`.
const stage = { x: 8, y: 111, width: 377, height: 625 };
const ids = (count: number) => Array.from({ length: count }, (_, index) => String(index));
const input = (overrides: Partial<StageInput>): StageInput => ({ stage, portrait: true, layout: "spotlight", order: ids(6), spot: "1", pinned: null, content: null, ...overrides });
const rounded = (item: StageItem) => [item.frame.x, item.frame.y, item.frame.width, item.frame.height].map((value) => Math.round(value * 10) / 10);

describe("stageLayout", () => {
  it("floats you over the other person when two are in the call (P2)", () => {
    const [main, you] = stageLayout(input({ order: ids(2) }));
    expect(main).toMatchObject({ kind: "person", id: "1", frame: stage });
    expect(you).toMatchObject({ kind: "person", id: "0", float: true });
    if (you) expect(rounded(you)).toEqual([277, 123, 96, 128]);
  });

  it("puts the speaker big and everyone else in justified rows below (P3, G1)", () => {
    const items = stageLayout(input({}));
    expect(items.map((item) => (item.kind === "person" ? item.id : item.kind))).toEqual(["1", "0", "2", "3", "4", "5"]);
    expect(items[0]).toMatchObject({ big: true });
    expect(items.map(rounded)).toEqual([
      [8, 111, 377, 429],
      [8, 548, 120.3, 90],
      [136.3, 548, 120.3, 90],
      [264.7, 548, 120.3, 90],
      [8, 646, 184.5, 90],
      [200.5, 646, 184.5, 90],
    ]);
  });

  it("keeps a pinned person big over the speaker", () => {
    expect(stageLayout(input({ pinned: "4" }))[0]).toMatchObject({ kind: "person", id: "4", big: true });
  });

  it("fills the stage with 24 tiles in Grid (P4, G2)", () => {
    const items = stageLayout(input({ layout: "grid", order: ids(24) }));
    expect(items).toHaveLength(24);
    expect(items.every((item) => item.kind === "person" && Math.round(item.frame.width * 10) / 10 === 88.3)).toBe(true);
  });

  it("stands a phone share at full height with people beside it (C2, S4)", () => {
    const [share, ...rest] = stageLayout(input({ content: { kind: "screen", aspect: 9 / 16 } }));
    expect(share).toMatchObject({ kind: "content", mini: false });
    if (share) expect(rounded(share)).toEqual([8, 111, 249, 625]);
    expect(rest.every((item) => item.frame.x === 265 && item.frame.width === 120)).toBe(true);
  });

  it("gives a shared board the stage with one row of people and a +N tile (C3)", () => {
    const items = stageLayout(input({ content: { kind: "board", aspect: null } }));
    expect(items[0] && rounded(items[0])).toEqual([8, 111, 377, 511]);
    expect(items.at(-1)).toMatchObject({ kind: "more", count: 3 });
  });

  it("shows the share as a double tile in Grid", () => {
    const [share] = stageLayout(input({ layout: "grid", content: { kind: "screen", aspect: 16 / 9 } }));
    expect(share).toMatchObject({ kind: "content", mini: true });
  });
});

describe("nextStageOrder", () => {
  it("swaps a new speaker with the person in the spotlight, so only those two tiles move", () => {
    const start = nextStageOrder({ order: [], spot: null }, ["you", "a", "b", "c"], "you", null);
    expect(start).toEqual({ order: ["you", "a", "b", "c"], spot: "a" });
    expect(nextStageOrder(start, ["you", "a", "b", "c"], "you", "c")).toEqual({ order: ["you", "c", "b", "a"], spot: "c" });
  });

  it("ignores your own speech and keeps the same object when nothing changes", () => {
    const start = nextStageOrder({ order: [], spot: null }, ["you", "a", "b"], "you", null);
    expect(nextStageOrder(start, ["you", "a", "b"], "you", "you")).toBe(start);
  });

  it("drops leavers, appends newcomers and moves the spotlight off someone who left", () => {
    const start = { order: ["you", "a", "b"], spot: "a" };
    expect(nextStageOrder(start, ["you", "b", "d"], "you", null)).toEqual({ order: ["you", "b", "d"], spot: "b" });
  });
});
