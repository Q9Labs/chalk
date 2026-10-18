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

  it("narrows the iPad stage when the side card is open", () => {
    const closed = frameRegions("pad", 820, 1180, { top: 24, bottom: 20, left: 0, right: 0 });
    const open = frameRegions("pad", 820, 1180, { top: 24, bottom: 20, left: 0, right: 0 }, true);
    expect(closed.stage.width - open.stage.width).toBe(352);
    expect(closed.stage.y).toBe(84);
  });
});

describe("arrangementFor", () => {
  it("uses the laptop arrangement on an iPad and the phone layout in narrow Split View", () => {
    expect(arrangementFor(820, 1180)).toBe("pad");
    expect(arrangementFor(1180, 820)).toBe("pad");
    expect(arrangementFor(320, 1180)).toBe("portrait");
    expect(arrangementFor(375, 820)).toBe("portrait");
    expect(arrangementFor(852, 393)).toBe("landscape");
  });
});
