import type { ExcalidrawElement, ExcalidrawFreeDrawElement, ExcalidrawLinearElement, ExcalidrawTextElement, FileId, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { HIGHLIGHTER_OPACITY, NOTE_COLOR, NOTE_OPACITY, annotationMarkOpacity, layoutAnnotationText, projectAnnotationMark, type AnnotationPoint, type AnnotationRect, type AnnotationTextMeasure, type ScreenAnnotationFrame } from "@q9labsai/chalk-screen-annotation";
import { generateKeyBetween } from "fractional-indexing";

import { engineStrokeWidth } from "../react/board/board-model";

type Style = Pick<ExcalidrawElement, "opacity" | "strokeColor" | "strokeWidth">;
type ElementBase = Omit<OrderedExcalidrawElement, "type">;
type LocalPoint = ExcalidrawLinearElement["points"][number];

export type AnnotationWhiteboardPlacement = {
  readonly origin: AnnotationPoint;
  readonly afterIndex: string | null;
};

const TRANSPARENT = "transparent";
const NUNITO_FONT = 6;
const BASE_GAP = 48;

/** Place beside the live scene at board scale, and append above existing elements in z-order. */
export function annotationWhiteboardPlacement(elements: readonly ExcalidrawElement[], emptyOrigin: AnnotationPoint): AnnotationWhiteboardPlacement {
  let afterIndex: string | null = null;
  let right = -Infinity;
  let top = Infinity;
  for (const element of elements) {
    if (element.index !== null && (afterIndex === null || element.index > afterIndex)) afterIndex = element.index;
    if (element.isDeleted) continue;
    const { x, y, width, height, angle } = element;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    right = Math.max(right, x + width / 2 + (width * cos + height * sin) / 2);
    top = Math.min(top, y + height / 2 - (width * sin + height * cos) / 2);
  }
  return { origin: right === -Infinity ? { ...emptyOrigin } : { x: right + BASE_GAP, y: top }, afterIndex };
}

export function annotationBoardElements(frame: ScreenAnnotationFrame, placement: AnnotationWhiteboardPlacement, importId: string, fileId: FileId, measureText: AnnotationTextMeasure): readonly OrderedExcalidrawElement[] {
  const rect: AnnotationRect = { ...placement.origin, ...frame.size };
  const firstIndex = generateKeyBetween(placement.afterIndex, null);
  const indexNamespace = importId.replaceAll("-", "");
  let sequence = 0;
  const base = (bounds: AnnotationRect, style: Style, groupId?: string): ElementBase => {
    const ordinal = sequence++;
    return {
      ...bounds,
      ...style,
      id: `annotation-${importId}-${ordinal}`,
      // Imports that append against the same scene order still get distinct, contiguous key ranges.
      index: `${firstIndex}${indexNamespace}${ordinal.toString(36).padStart(4, "0")}1` as OrderedExcalidrawElement["index"],
      angle: 0 as ExcalidrawElement["angle"],
      backgroundColor: TRANSPARENT,
      fillStyle: "solid",
      strokeStyle: "solid",
      roundness: null,
      roughness: 0,
      seed: Number.parseInt(indexNamespace.slice(0, 7), 16),
      version: 1,
      versionNonce: 0,
      isDeleted: false,
      groupIds: groupId ? [groupId] : [],
      frameId: null,
      boundElements: null,
      updated: frame.nowMs,
      link: null,
      locked: false,
    };
  };

  const elements: OrderedExcalidrawElement[] = [{ ...base(rect, { opacity: 100, strokeColor: TRANSPARENT, strokeWidth: 0 }), type: "image", fileId, status: "saved", scale: [1, 1], crop: null }];

  for (const mark of frame.marks) {
    const alpha = annotationMarkOpacity(mark, frame.nowMs);
    if (alpha <= 0) continue;
    const opacity = Math.max(1, Math.round(alpha * 100));
    const geometry = projectAnnotationMark(rect, mark.draft);
    const style = { opacity, strokeColor: geometry.color, strokeWidth: geometry.width };
    const group = `${importId}-${mark.draft.mark_id}`;
    if (geometry.kind === "text") {
      appendText(elements, base, geometry, style, measureText, group);
    } else if (geometry.kind === "stamp") {
      appendStamp(elements, base, geometry, style, group);
    } else {
      appendShape(elements, base, geometry, style);
    }
  }
  return elements;
}

type Geometry = ReturnType<typeof projectAnnotationMark>;
type ElementFactory = (bounds: AnnotationRect, style: Style, groupId?: string) => ElementBase;

function appendShape(elements: OrderedExcalidrawElement[], base: ElementFactory, geometry: Exclude<Geometry, { kind: "text" | "stamp" }>, style: Style): void {
  switch (geometry.kind) {
    case "pen":
    case "highlighter":
      appendInk(elements, base, geometry, style);
      break;
    case "line":
    case "arrow": {
      const path = shapePath([geometry.from, geometry.to]);
      if (!path) break;
      if (path.bounds.width === 0 && path.bounds.height === 0) {
        elements.push(dot(base(dotBounds(geometry.from, style.strokeWidth / 2), style)));
      } else {
        const line = linear(base(path.bounds, style), path.points);
        elements.push(geometry.kind === "arrow" ? { ...line, type: "arrow", endArrowhead: "triangle", elbowed: false } : line);
      }
      break;
    }
    case "box":
    case "circle": {
      const { bounds } = geometry;
      if (bounds.width === 0 || bounds.height === 0) {
        const path = shapePath([bounds, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }]);
        if (bounds.width === 0 && bounds.height === 0) elements.push(dot(base(dotBounds(bounds, style.strokeWidth / 2), style)));
        else if (path) elements.push(linear(base(path.bounds, style), path.points));
      } else {
        const type = geometry.kind === "box" ? "rectangle" : "ellipse";
        elements.push({ ...base(bounds, style), type, roundness: geometry.kind === "box" ? { type: 3, value: style.strokeWidth * 2 } : null });
      }
      break;
    }
  }
}

function appendInk(elements: OrderedExcalidrawElement[], base: ElementFactory, geometry: Extract<Geometry, { kind: "pen" | "highlighter" }>, style: Style): void {
  const inkStyle = { ...style, opacity: geometry.kind === "highlighter" ? Math.max(1, Math.round(style.opacity * HIGHLIGHTER_OPACITY)) : style.opacity };
  const path = shapePath(geometry.points);
  if (!path) return;
  if (path.bounds.width === 0 && path.bounds.height === 0) {
    elements.push(dot(base(dotBounds(path.bounds, style.strokeWidth / 2), inkStyle)));
  } else {
    elements.push({
      ...base(path.bounds, { ...inkStyle, strokeWidth: engineStrokeWidth(style.strokeWidth, true) }),
      type: "freedraw",
      points: path.points,
      pressures: path.points.map(() => 0.5),
      simulatePressure: false,
      lastCommittedPoint: null,
    });
  }
}

function appendText(elements: OrderedExcalidrawElement[], base: ElementFactory, geometry: Extract<Geometry, { kind: "text" }>, style: Style, measureText: AnnotationTextMeasure, markGroup: string): void {
  const text = layoutAnnotationText(geometry, measureText);
  const group = geometry.note ? markGroup : undefined;
  if (geometry.note) {
    elements.push({
      ...base(text.noteBounds, { ...style, opacity: Math.round(style.opacity * NOTE_OPACITY), strokeColor: TRANSPARENT, strokeWidth: 0 }, group),
      type: "rectangle",
      backgroundColor: NOTE_COLOR,
      roundness: { type: 3, value: text.radius },
    });
  }
  elements.push({
    ...base(text.bounds, style, group),
    type: "text",
    fontFamily: NUNITO_FONT,
    fontSize: geometry.fontSize,
    lineHeight: (text.lineHeight / geometry.fontSize) as ExcalidrawTextElement["lineHeight"],
    text: text.lines.join("\n"),
    originalText: text.lines.join("\n"),
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
  });
}

function appendStamp(elements: OrderedExcalidrawElement[], base: ElementFactory, geometry: Extract<Geometry, { kind: "stamp" }>, style: Style, group: string): void {
  const bounds = dotBounds(geometry.at, geometry.radius);
  elements.push({ ...base(bounds, style, group), type: "ellipse", backgroundColor: NOTE_COLOR });
  for (const path of geometry.paths) {
    const shape = shapePath(path);
    if (!shape) continue;
    if (path.length === 1) elements.push(dot(base(dotBounds(shape.bounds, style.strokeWidth / 2), style, group)));
    else elements.push(linear(base(shape.bounds, style, group), shape.points));
  }
}

function dotBounds(point: AnnotationPoint, radius: number): AnnotationRect {
  return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
}

function dot(base: ElementBase): OrderedExcalidrawElement {
  return { ...base, type: "ellipse", backgroundColor: base.strokeColor, strokeColor: TRANSPARENT, strokeWidth: 0 };
}

function shapePath(points: readonly AnnotationPoint[]): { bounds: AnnotationRect; points: readonly LocalPoint[] } | null {
  const first = points[0];
  if (!first) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    bounds: { ...first, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    points: points.map((point) => [point.x - first.x, point.y - first.y] as LocalPoint),
  };
}

function linear(base: ElementBase, points: ExcalidrawFreeDrawElement["points"]): Extract<OrderedExcalidrawElement, { type: "line" | "arrow" }> {
  return { ...base, type: "line", points, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null };
}
