import { ChalkWhiteboardViewBounds } from "@q9labsai/chalk-client";
import { expect, it } from "vitest";
import { cameraForView, visibleView } from "../../../../../../packages/whiteboard/src/react/board/board-model";

it.each([-2_000_000, 2_000_000])("bounds a view at distant board coordinate %s", (coordinate) => {
  expect(visibleView({ scrollX: coordinate, scrollY: -coordinate, zoom: 0.1 }, { width: 1_000_000, height: 1_000_000 }, ChalkWhiteboardViewBounds)).toEqual({ x: -Math.sign(coordinate) * 1_000_000, y: Math.sign(coordinate) * 1_000_000, width: 2_000_000, height: 2_000_000 });
});

it.each([0.5, 1, 2.5])("Follow centres a desktop view at the follower's own zoom %s", (zoom) => {
  const camera = cameraForView({ x: 100, y: 200, width: 1440, height: 900 }, { width: 390, height: 844 }, zoom);
  expect(camera.zoom).toBe(zoom);
  expect(390 / (2 * zoom) - camera.scrollX).toBe(820);
  expect(844 / (2 * zoom) - camera.scrollY).toBe(650);
});
