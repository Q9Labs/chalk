import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { createPainter } from "./paint.js";
import { createPainter as createOldPainter } from "./paint-old.tmp.js";
import type { Scene, SceneParticipant } from "./scene.js";

async function options() {
  const swatch = createCanvas(40, 30);
  const swatchContext = swatch.getContext("2d");
  swatchContext.fillStyle = "#3366CC";
  swatchContext.fillRect(0, 0, 40, 30);
  swatchContext.fillStyle = "#CC6633";
  swatchContext.fillRect(10, 5, 15, 15);
  const image = await loadImage(await swatch.encode("png"));
  return {
    width: 1280,
    height: 720,
    fontFamilies: "sans-serif",
    loadAsset: async () => image,
    renderWhiteboard: async () => {
      const board = createCanvas(300, 200);
      const context = board.getContext("2d");
      context.fillStyle = "#88AA33";
      context.fillRect(20, 20, 200, 100);
      return board;
    },
  };
}

const person = (id: string, displayName: string, overrides: Partial<SceneParticipant> = {}): SceneParticipant => ({ id, displayName, microphoneMuted: false, handRaised: false, speaking: false, ...overrides });

function scene(colorScheme: "light" | "dark"): Scene {
  return {
    spaceName: "Weekly design review with a very long space name that has to be shortened to fit",
    logoAssetId: "logo",
    colorScheme,
    generatedAvatars: true,
    tiles: [
      { kind: "participant", rect: { x: 16, y: 64, width: 400, height: 300 }, participant: person("a", "Avery Chen", { speaking: true }), video: { sourceId: "s1", fit: "cover" } },
      { kind: "participant", rect: { x: 432, y: 64, width: 400, height: 300 }, participant: person("b", "Morgan Diaz", { microphoneMuted: true, handRaised: true }) },
      { kind: "participant", rect: { x: 848, y: 64, width: 416, height: 300 }, participant: person("c", "Riley", { avatarAssetId: "avatar" }) },
      { kind: "screen_share", rect: { x: 16, y: 380, width: 400, height: 260 }, participant: person("b", "Morgan Diaz") },
      { kind: "screen_share", rect: { x: 432, y: 380, width: 400, height: 260 }, participant: person("b", "Morgan Diaz"), video: { sourceId: "s2", fit: "contain" } },
      { kind: "whiteboard", rect: { x: 848, y: 380, width: 416, height: 260 }, stateAssetId: "board", revision: 2 },
    ],
    reactions: ["👍", "🎉", "❤️", "😂", "😮"].map((value, index) => ({ value, displayName: `Reactor number ${index} with a long name` })),
  };
}

describe("painter refactor", () => {
  it.each(["light", "dark"] as const)("paints %s exactly like the previous painter", async (colorScheme) => {
    const next = createPainter(await options());
    const previous = createOldPainter(await options());
    const [a, b] = [await next.paint(scene(colorScheme)), await previous.paint(scene(colorScheme))];
    expect(a.byteLength).toBeGreaterThan(1_000);
    expect(a.equals(b)).toBe(true);
  });
});
