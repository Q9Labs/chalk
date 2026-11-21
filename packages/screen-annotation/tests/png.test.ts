import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ScreenAnnotationMark } from "@q9labsai/chalk-client";
import { expect, it } from "vitest";

import { FRAME_UNITS, freezeAnnotationFrame, renderAnnotationPng } from "../src/index";

it("freezes the accepted scene and clock, exports native-size PNG, and leaves the source pristine", async () => {
  const source = createCanvas(128, 80);
  const sourceContext = source.getContext("2d");
  sourceContext.fillStyle = "#121619";
  sourceContext.fillRect(0, 0, source.width, source.height);
  sourceContext.fillStyle = "#ffbb00";
  sourceContext.fillRect(72, 20, 24, 8);
  const yellowPixel = [255, 187, 0, 255];
  const backgroundPixel = [18, 22, 25, 255];
  const mutablePoint = { x: FRAME_UNITS / 2, y: FRAME_UNITS / 2 };
  const kept: ScreenAnnotationMark = {
    author: { participant_id: "sharer", display_name: "Alex", color: "#1155ff" },
    draft: { mark_id: "kept", lifetime: "keep", width: 2000, color: "#1155ff", shape: { kind: "pen", points: [mutablePoint] } },
    committed_at_ms: 1000,
    expires_at_ms: null,
    created_revision: 1,
  };
  const visibleFade: ScreenAnnotationMark = {
    ...kept,
    draft: { ...kept.draft, mark_id: "faded", lifetime: "fade", color: "#ff0000", shape: { kind: "pen", points: [{ x: FRAME_UNITS / 4, y: FRAME_UNITS / 2 }] } },
    created_revision: 2,
    expires_at_ms: 3000,
  };
  const expired: ScreenAnnotationMark = {
    ...visibleFade,
    draft: { ...visibleFade.draft, mark_id: "expired", shape: { kind: "pen", points: [{ x: FRAME_UNITS / 8, y: FRAME_UNITS / 2 }] } },
    created_revision: 3,
    expires_at_ms: 2600,
  };
  const paused: ScreenAnnotationMark = { ...kept, draft: { ...kept.draft, mark_id: "hidden" }, author: { ...kept.author, participant_id: "viewer" }, created_revision: 4 };
  const marks = [paused, expired, visibleFade, kept];
  const frame = freezeAnnotationFrame({ size: source, image: source, publicationId: "screen-publication", marks, nowMs: 2700, paused: true, sharerId: "sharer" });
  mutablePoint.x = 0;
  marks.length = 0;

  expect(frame.marks.map((item) => item.draft.mark_id)).toEqual(["kept", "faded"]);
  const png = await renderAnnotationPng(frame, ({ width, height }) => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return {
      context,
      drawFrame: (image) => context.drawImage(image, 0, 0),
      encodePng: () => canvas.encode("png"),
    };
  });
  const decoded = await loadImage(png);
  expect([decoded.width, decoded.height]).toEqual([128, 80]);
  const output = createCanvas(decoded.width, decoded.height).getContext("2d");
  output.drawImage(decoded, 0, 0);
  expect([...output.getImageData(80, 23, 1, 1).data]).toEqual(yellowPixel);
  expect([...output.getImageData(64, 40, 1, 1).data]).toEqual([17, 85, 255, 255]);
  expect([...output.getImageData(16, 40, 1, 1).data]).toEqual(backgroundPixel);
  expect(output.getImageData(32, 40, 1, 1).data[0]).toBeGreaterThan(100);
  expect([...sourceContext.getImageData(64, 40, 1, 1).data]).toEqual(backgroundPixel);
});
