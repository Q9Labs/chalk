import { ChalkWhiteboardViewBounds } from "@q9labsai/chalk-client";
import { expect, it } from "vitest";
import { visibleView } from "../../../../../../packages/whiteboard/src/react/board/board-model";

it.each([-2_000_000, 2_000_000])("bounds a view at distant board coordinate %s", (coordinate) => {
  expect(visibleView({ scrollX: coordinate, scrollY: -coordinate, zoom: 0.1 }, { width: 1_000_000, height: 1_000_000 }, ChalkWhiteboardViewBounds)).toEqual({ x: -Math.sign(coordinate) * 1_000_000, y: Math.sign(coordinate) * 1_000_000, width: 2_000_000, height: 2_000_000 });
});
