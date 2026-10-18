import { describe, expect, it } from "vitest";
import { placeMenu } from "./menu-placement";

const iphone = { width: 393, height: 852 };
const iphoneInsets = { top: 59, bottom: 34, left: 0, right: 0 };
const menu = { width: 250, height: 200 };

describe("placeMenu", () => {
  it("opens below a trigger near the top instead of covering the status bar and Dynamic Island", () => {
    const placement = placeMenu({ x: 337, y: 66, width: 44, height: 44 }, menu, iphone, iphoneInsets);
    expect(placement.side).toBe("below");
    expect(placement.y).toBe(66 + 44 + 6);
    expect(placement.y).toBeGreaterThanOrEqual(iphoneInsets.top + 8);
  });

  it("flips above only when there is more room above", () => {
    const placement = placeMenu({ x: 20, y: 700, width: 44, height: 44 }, menu, iphone, iphoneInsets);
    expect(placement.side).toBe("above");
    expect(placement.y).toBe(700 - 6 - 200);
  });

  it("stays below when the menu fits below even if there is more room above", () => {
    const placement = placeMenu({ x: 20, y: 500, width: 44, height: 44 }, menu, iphone, iphoneInsets);
    expect(placement.side).toBe("below");
  });

  it("shifts sideways to stay inside the screen edges", () => {
    expect(placeMenu({ x: 349, y: 300, width: 44, height: 44 }, menu, iphone, iphoneInsets).x).toBe(393 - 8 - 250);
    expect(placeMenu({ x: 0, y: 300, width: 44, height: 44 }, menu, iphone, iphoneInsets).x).toBe(8);
  });

  it("respects landscape side insets", () => {
    const landscape = { width: 852, height: 393 };
    const placement = placeMenu({ x: 0, y: 100, width: 44, height: 44 }, menu, landscape, { top: 0, bottom: 21, left: 59, right: 59 });
    expect(placement.x).toBe(59 + 8);
  });

  it("never covers the home indicator or the keyboard", () => {
    const placement = placeMenu({ x: 100, y: 760, width: 44, height: 44 }, { width: 250, height: 120 }, iphone, iphoneInsets);
    expect(placement.y + 120).toBeLessThanOrEqual(852 - 34 - 8);
    const withKeyboard = placeMenu({ x: 100, y: 420, width: 44, height: 44 }, { width: 250, height: 120 }, iphone, iphoneInsets, 336);
    expect(withKeyboard.y + 120).toBeLessThanOrEqual(852 - 336 - 8);
  });

  it("caps a menu taller than the safe area and lets it scroll", () => {
    const placement = placeMenu({ x: 100, y: 300, width: 44, height: 44 }, { width: 250, height: 2000 }, iphone, iphoneInsets);
    expect(placement.maxHeight).toBe(852 - 34 - 8 - (59 + 8));
    expect(placement.y).toBe(59 + 8);
  });
});
