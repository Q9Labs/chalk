import { describe, expect, it } from "vitest";
import { normalizeMenuAnchor, placeMenu } from "./menu-placement";

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

describe("normalizeMenuAnchor", () => {
  it("keeps an inset SDK menu next to the trigger measured in the native window", () => {
    const frame = { x: 48, y: 96, width: 322, height: 746 };
    const trigger = { x: 118, y: 124, width: 100, height: 44 };
    const local = normalizeMenuAnchor(trigger, frame);
    expect(local).toEqual({ x: 70, y: 28, width: 100, height: 44 });
    const placement = placeMenu(local, { width: 180, height: 110 }, frame, { top: 0, bottom: 0, left: 0, right: 0 });
    expect(placement.x + frame.x).toBe(trigger.x + trigger.width / 2 - 90);
    expect(placement.y + frame.y).toBe(trigger.y + trigger.height + 6);
  });

  it("keeps a landscape menu inside its cutout-safe allocated frame", () => {
    const frame = { x: 48, y: 96, width: 794, height: 274 };
    const trigger = { x: 50, y: 124, width: 44, height: 44 };
    const placement = placeMenu(normalizeMenuAnchor(trigger, frame), { width: 180, height: 110 }, frame, { top: 0, bottom: 0, left: 14, right: 0 });
    expect(placement.x).toBe(14 + 8);
    expect(placement.y + frame.y).toBe(trigger.y + trigger.height + 6);
  });

  it("leaves window-sized anchors unchanged after the external notice is dismissed", () => {
    const trigger = { x: 70, y: 90, width: 100, height: 44 };
    expect(normalizeMenuAnchor(trigger, { x: 0, y: 0, width: 402, height: 874 })).toEqual(trigger);
  });
});
