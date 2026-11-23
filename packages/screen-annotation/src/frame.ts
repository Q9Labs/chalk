import type { ScreenAnnotationFrameSize, ScreenAnnotationMark, ScreenAnnotationShape } from "@q9labsai/chalk-client";

import { annotationMarkOpacity, compareAnnotationMarks } from "./mark-geometry";

export type ScreenAnnotationFrame<Image = unknown> = {
  readonly publicationId: string;
  readonly size: ScreenAnnotationFrameSize;
  /** An already-captured image, not a live video source. The calling surface owns its lifetime. */
  readonly image: Image;
  readonly marks: readonly ScreenAnnotationMark[];
  readonly nowMs: number;
};

export type ScreenAnnotationActions<Image = unknown> = {
  readonly saveToWhiteboard?: (frame: ScreenAnnotationFrame<Image>) => Promise<void>;
  readonly downloadPng?: (frame: ScreenAnnotationFrame<Image>) => Promise<void>;
};

export type FreezeAnnotationFrameInput<Image> = ScreenAnnotationFrame<Image> & {
  readonly sharerId?: string;
  readonly paused?: boolean;
};

export function freezeAnnotationFrame<Image>({ publicationId, size, image, marks, nowMs, paused, sharerId }: FreezeAnnotationFrameInput<Image>): ScreenAnnotationFrame<Image> {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) throw new RangeError("Invalid annotation frame size");

  const visible = marks.filter((mark) => (!paused || mark.author.participant_id === sharerId) && annotationMarkOpacity(mark, nowMs) > 0);
  return Object.freeze({
    publicationId,
    size: Object.freeze({ width: size.width, height: size.height }),
    image,
    marks: Object.freeze(visible.sort(compareAnnotationMarks).map(copyMark)),
    nowMs,
  });
}

function copyMark(mark: ScreenAnnotationMark): ScreenAnnotationMark {
  return Object.freeze({
    ...mark,
    author: Object.freeze({ ...mark.author }),
    draft: Object.freeze({ ...mark.draft, shape: copyShape(mark.draft.shape) }),
  });
}

function copyShape(shape: ScreenAnnotationShape): ScreenAnnotationShape {
  switch (shape.kind) {
    case "pen":
    case "highlighter":
      return Object.freeze({ ...shape, points: Object.freeze(shape.points.map((point) => Object.freeze({ ...point }))) });
    case "line":
    case "arrow":
    case "box":
    case "circle":
      return Object.freeze({ ...shape, from_point: Object.freeze({ ...shape.from_point }), to_point: Object.freeze({ ...shape.to_point }) });
    case "text":
    case "stamp":
      return Object.freeze({ ...shape, at: Object.freeze({ ...shape.at }) });
  }
}
