import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { createPainter, initials } from "./paint.js";
import type { Scene } from "./scene.js";

describe("native painter", () => {
  it.each([
    ["Avery Chen", "AC"],
    ["  Morgan  Diaz ", "MD"],
    ["Riley", "RI"],
    ["", "?"],
  ])("turns %j into initials", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });

  it("paints a scene as a correctly sized PNG", async () => {
    const painter = createPainter({
      width: 320,
      height: 180,
      fontFamilies: "Arial, sans-serif",
      loadAsset: async () => {
        throw new Error("unexpected asset");
      },
      renderWhiteboard: async () => createCanvas(1, 1),
    });
    const scene: Scene = {
      spaceName: "Review",
      colorScheme: "light",
      generatedAvatars: true,
      tiles: [{ kind: "participant", rect: { x: 8, y: 24, width: 150, height: 140 }, participant: { id: "a", displayName: "Avery Chen", microphoneMuted: false, handRaised: true, speaking: true } }],
      reactions: [{ value: "👍", displayName: "Avery Chen" }],
    };
    const png = await painter.paint(scene);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(180);
  });
});
