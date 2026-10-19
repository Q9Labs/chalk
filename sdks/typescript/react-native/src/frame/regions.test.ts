import { describe, expect, it } from "vitest";
import { arrangementFor, frameRegions } from "./regions";

describe("frameRegions", () => {
  it("matches the mockup's D1 iPhone portrait stage", () => {
    const { header, stage, dock } = frameRegions("portrait", 393, 852, { top: 59, bottom: 34, left: 0, right: 0 });
    expect(header).toEqual({ x: 0, y: 59, width: 393, height: 52 });
    expect(stage).toEqual({ x: 8, y: 111, width: 377, height: 852 - 111 - (34 + 8 + 52 + 14) - 8 });
    expect(dock.y + dock.height).toBe(852 - 34 - 14);
  });

  it("gives the phone stage the whole screen in landscape, inside the side insets", () => {
    const { stage } = frameRegions("landscape", 852, 393, { top: 0, bottom: 21, left: 59, right: 59 });
    expect(stage).toEqual({ x: 67, y: 8, width: 852 - 118 - 16, height: 393 - 8 - 21 - 4 });
  });

  it("starts the landscape header and stage below the top inset, as portrait does", () => {
    const { header, stage } = frameRegions("landscape", 852, 393, { top: 24, bottom: 0, left: 0, right: 0 });
    expect(header.y).toBe(32);
    expect(stage).toEqual({ x: 8, y: 32, width: 852 - 16, height: 393 - 32 - 0 - 4 });
  });

  it("narrows the iPad stage when the side card is open", () => {
    const closed = frameRegions("pad", 820, 1180, { top: 24, bottom: 20, left: 0, right: 0 });
    const open = frameRegions("pad", 820, 1180, { top: 24, bottom: 20, left: 0, right: 0 }, true);
    expect(closed.stage.width - open.stage.width).toBe(352);
    expect(closed.stage.y).toBe(84);
  });
});

describe("arrangementFor", () => {
  it("gives the iPad the phone layout today, like a phone", () => {
    expect(arrangementFor(820, 1180)).toBe("portrait");
    expect(arrangementFor(1180, 820)).toBe("landscape");
    expect(arrangementFor(375, 820)).toBe("portrait");
    expect(arrangementFor(852, 393)).toBe("landscape");
  });
});
