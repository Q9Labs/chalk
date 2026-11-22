import type { ScreenAnnotationMark, ScreenAnnotationPoint, ScreenAnnotationShape } from "@q9labsai/chalk-client";
import { exactKeys, field, objectValue, stringField } from "../validation.js";
import { LABEL, MAXIMUM_TIME, booleanField, color, integer, invalid, list, record, uuid } from "./annotation-archive-fields.js";

const COMMITTED_FADE_TTL_MS_V1 = 2_000;
const MAX_MARK_POINTS = 384;
const MAX_MARK_TEXT_BYTES = 512;

export function parseMark(value: unknown): ScreenAnnotationMark {
  const mark = record(value, ["draft", "author", "created_revision", "committed_at_ms", "expires_at_ms"]);
  const draft = record(field(mark, "draft"), ["mark_id", "lifetime", "color", "width", "shape"]);
  const lifetime = field(draft, "lifetime");
  if (lifetime !== "fade" && lifetime !== "keep") throw invalid("has an invalid mark lifetime");
  const committedAtMs = integer(mark, "committed_at_ms", -MAXIMUM_TIME);
  validateMarkExpiry(mark, lifetime, committedAtMs);
  const author = record(field(mark, "author"), ["participant_id", "display_name", "color"]);
  return {
    draft: { mark_id: uuid(draft, "mark_id"), lifetime, color: color(draft), width: integer(draft, "width", 32, 3277), shape: parseShape(field(draft, "shape")) },
    author: { participant_id: uuid(author, "participant_id"), display_name: stringField(author, "display_name", LABEL, 256), color: color(author) },
    created_revision: integer(mark, "created_revision", 1),
    committed_at_ms: committedAtMs,
    expires_at_ms: lifetime === "fade" ? integer(mark, "expires_at_ms", -MAXIMUM_TIME) : null,
  };
}

function validateMarkExpiry(mark: object, lifetime: ScreenAnnotationMark["draft"]["lifetime"], committedAtMs: number): void {
  const expected = lifetime === "fade" ? committedAtMs + COMMITTED_FADE_TTL_MS_V1 : null;
  if (field(mark, "expires_at_ms") !== expected) throw invalid("has an invalid mark expiry");
}

const shapeParsers = new Map<unknown, (shape: object) => ScreenAnnotationShape>([
  ["pen", (shape) => parseStroke(shape, "pen")],
  ["highlighter", (shape) => parseStroke(shape, "highlighter")],
  ["line", (shape) => parseEndpoints(shape, "line")],
  ["arrow", (shape) => parseEndpoints(shape, "arrow")],
  ["box", (shape) => parseEndpoints(shape, "box")],
  ["circle", (shape) => parseEndpoints(shape, "circle")],
  ["text", parseText],
  ["stamp", parseStamp],
]);

function parseShape(value: unknown): ScreenAnnotationShape {
  const shape = objectValue(value, LABEL);
  const parse = shapeParsers.get(field(shape, "kind"));
  if (!parse) throw invalid("has an invalid shape kind");
  return parse(shape);
}

function parseStroke(shape: object, kind: "pen" | "highlighter"): ScreenAnnotationShape {
  exactKeys(shape, ["kind", "points"], LABEL);
  const points = list(field(shape, "points"), MAX_MARK_POINTS).map(point);
  if (points.length === 0) throw invalid("has an empty stroke");
  return { kind, points };
}

function parseEndpoints(shape: object, kind: "line" | "arrow" | "box" | "circle"): ScreenAnnotationShape {
  exactKeys(shape, ["kind", "from_point", "to_point"], LABEL);
  return { kind, from_point: point(field(shape, "from_point")), to_point: point(field(shape, "to_point")) };
}

function parseText(shape: object): ScreenAnnotationShape {
  exactKeys(shape, ["kind", "at", "text", "note"], LABEL);
  const text = stringField(shape, "text", LABEL, MAX_MARK_TEXT_BYTES);
  if (Buffer.byteLength(text, "utf8") > MAX_MARK_TEXT_BYTES) throw invalid("has oversized mark text");
  return { kind: "text", at: point(field(shape, "at")), note: booleanField(shape, "note"), text };
}

const stamps = new Set<unknown>(["check", "cross", "star", "question", "heart"]);

function parseStamp(shape: object): ScreenAnnotationShape {
  exactKeys(shape, ["kind", "at", "stamp"], LABEL);
  const stamp = field(shape, "stamp");
  if (!stamps.has(stamp)) throw invalid("has an invalid stamp");
  return { kind: "stamp", at: point(field(shape, "at")), stamp: stamp as Extract<ScreenAnnotationShape, { kind: "stamp" }>["stamp"] };
}

function point(value: unknown): ScreenAnnotationPoint {
  const point = record(value, ["x", "y"]);
  return { x: integer(point, "x", 0, 65535), y: integer(point, "y", 0, 65535) };
}
