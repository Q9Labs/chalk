import { describe, expect, it } from "vitest";
import { createWhiteboardRenderer } from "./whiteboard.js";

const COLORS = ["#ff0000", "#00ff00", "#0000ff"] as const;

// Browser freehand elements carry relative points, simulated pressure and no
// committed point after pointerup. Keep these strokes synthetic and independent.
const STATE = {
  schemaVersion: "recording_whiteboard_state.v1",
  sceneId: "synthetic-scene",
  revision: 4,
  appState: {},
  elements: COLORS.map((strokeColor, index) => ({
    id: `stroke-${index}`,
    type: "freedraw",
    version: 14,
    version_nonce: index + 1,
    index: `a${index}`,
    is_deleted: false,
    payload: {
      x: 20,
      y: 20 + index * 60,
      width: 160,
      height: 30,
      angle: 0,
      strokeColor,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 3,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: index + 100,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      points: [
        [0, 0],
        [30, 15],
        [60, -15],
        [100, 10],
        [160, 0],
      ],
      pressures: [],
      simulatePressure: true,
      lastCommittedPoint: null,
    },
  })),
};

describe("recorded whiteboard export", () => {
  it("paints every browser freehand stroke instead of silently returning a blank canvas", async () => {
    const render = createWhiteboardRenderer({
      fontsDirectory: "/unused-synthetic-fonts",
      loadAsset: async () => ({ bytes: Buffer.from(JSON.stringify(STATE)), contentType: "application/json" }),
    });
    const canvas = await render("synthetic-state", "light", { x: 0, y: 0, width: 640, height: 480 });
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const ink = [0, 0, 0];
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3]! < 128) continue;
      for (let channel = 0; channel < 3; channel++) {
        if (pixels[offset + channel]! > 200 && pixels[offset + ((channel + 1) % 3)]! < 50 && pixels[offset + ((channel + 2) % 3)]! < 50) ink[channel]!++;
      }
    }
    for (const [channel, count] of ink.entries()) expect(count, `stroke ${COLORS[channel]} must be visible`).toBeGreaterThan(100);
    // The first render loads the drawing library cold: 2.5 s under coverage on a laptop, over 5 s on a CI runner.
  }, 30_000);
});
