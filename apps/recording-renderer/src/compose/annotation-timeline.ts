import type { ScreenAnnotationMark } from "@q9labsai/chalk-client";
import { ACTIVE_MARKS_V1, type BoundAnnotationLayer } from "./annotation-sidecar.js";
import type { Rect, SceneSpan, VideoSegment } from "./scene.js";

const FADE_OUT_MS_V1 = 600;

export interface AnnotationOverlay {
  readonly content: Rect;
  readonly marks: readonly ScreenAnnotationMark[];
  readonly atMs: number;
}

export interface AnnotationGeometry {
  readonly frame: number;
  readonly content: Rect;
}

interface LayerCursor {
  readonly layer: BoundAnnotationLayer;
  readonly at: (atMs: number) => { readonly marks: readonly ScreenAnnotationMark[]; readonly appearance: string };
}

export function createAnnotationTimeline(layers: readonly BoundAnnotationLayer[], fps: number) {
  const bySource = indexAnnotationLayers(layers);
  const firstFrame = (atMs: number): number => Math.ceil((atMs * fps) / 1_000);
  return {
    sourceFor(segment: VideoSegment) {
      return firstShareSource(segment, (sourceId) => bySource.get(sourceId)?.some(({ layer }) => overlapsSegment(layer, segment, firstFrame)) === true);
    },
    apply(segment: VideoSegment, sourceId: string, decodedStartMs: number, geometry: readonly AnnotationGeometry[]): VideoSegment {
      const cursors = bySource.get(sourceId) ?? [];
      const startFrame = Math.max(segment.startFrame, firstFrame(decodedStartMs));
      const frames = annotationFrames(cursors, geometry, startFrame, segment.endFrame, firstFrame);
      const nextBoundary = advanceOver(frames, (frame) => frame);
      const nextGeometry = advanceOver(geometry, (item) => item.frame, 1);
      const nextCursor = advanceOver(cursors, ({ layer }) => layer.closedAtMs);
      const spans: SceneSpan[] = [];
      for (const span of segment.spans) {
        for (let frame = span.startFrame; frame < span.endFrame; ) {
          const boundary = nextBoundary(frame);
          const rect = geometry[nextGeometry(frame) - 1]?.content;
          const endFrame = Math.min(span.endFrame, frames[boundary] ?? span.endFrame);
          const atMs = Math.floor((frame * 1_000) / fps);
          const cursor = cursors[nextCursor(atMs)];
          const visible = frame >= startFrame ? cursor?.at(atMs) : undefined;
          appendSpan(spans, withAnnotation({ ...span, startFrame: frame, endFrame }, sourceId, atMs, rect, visible, cursor?.layer.layer.layer_id));
          frame = endFrame;
        }
      }
      return { ...segment, spans };
    },
  };
}

function indexAnnotationLayers(layers: readonly BoundAnnotationLayer[]): Map<string, LayerCursor[]> {
  const bySource = new Map<string, LayerCursor[]>();
  for (const layer of layers.filter(hasRecordedMarks)) {
    const cursor = createLayerCursor(layer);
    for (const sourceId of layer.sourceIds) {
      const entries = bySource.get(sourceId) ?? [];
      entries.push(cursor);
      bySource.set(sourceId, entries);
    }
  }
  return bySource;
}

function hasRecordedMarks(layer: BoundAnnotationLayer): boolean {
  return layer.initial.marks.length > 0 || layer.changes.some(({ change }) => change.kind === "upsert");
}

function firstShareSource(segment: VideoSegment, eligible: (sourceId: string) => boolean): string | undefined {
  const first = segment.spans[0];
  return first?.scene.tiles.find((tile) => tile.kind === "screen_share" && tile.video !== undefined && eligible(tile.video.sourceId))?.video?.sourceId;
}

function overlapsSegment(layer: BoundAnnotationLayer, segment: VideoSegment, firstFrame: (atMs: number) => number): boolean {
  return firstFrame(layer.closedAtMs) > segment.startFrame && firstFrame(layer.initial.atMs) < segment.endFrame;
}

function annotationFrames(cursors: readonly LayerCursor[], geometry: readonly AnnotationGeometry[], startFrame: number, endFrame: number, firstFrame: (atMs: number) => number): number[] {
  const boundaries = new Set<number>([startFrame, ...geometry.map((item) => item.frame)]);
  for (const { layer } of cursors) collectBoundaries(boundaries, layer, startFrame, endFrame, firstFrame);
  return [...boundaries].filter((frame) => frame >= startFrame && frame < endFrame).sort((left, right) => left - right);
}

/** Returns the position just beyond the reached boundaries, without rescanning expired entries. */
function advanceOver<T>(items: readonly T[], boundary: (item: T) => number, index = 0): (at: number) => number {
  return (at) => {
    while (index < items.length && boundary(items[index]!) <= at) index++;
    return index;
  };
}

function withAnnotation(span: SceneSpan, sourceId: string, atMs: number, rect: Rect | undefined, visible: ReturnType<LayerCursor["at"]> | undefined, layerId: string | undefined): SceneSpan {
  if (!visible?.marks.length || rect === undefined) return span;
  const tiles = span.scene.tiles.map((tile) => (tile.kind === "screen_share" && tile.video?.sourceId === sourceId ? { ...tile, annotation: { content: rect, marks: visible.marks, atMs } } : tile));
  return { ...span, scene: { ...span.scene, tiles }, sceneKey: JSON.stringify([span.sceneKey, layerId, visible.appearance, rect]) };
}

function collectBoundaries(boundaries: Set<number>, layer: BoundAnnotationLayer, start: number, end: number, frameFor: (atMs: number) => number): void {
  const close = frameFor(layer.closedAtMs);
  const open = frameFor(layer.initial.atMs);
  if (open >= end || close <= start) return;
  boundaries.add(open);
  boundaries.add(close);
  const fade = (mark: ScreenAnnotationMark) => {
    if (mark.expires_at_ms === null) return;
    const stop = Math.min(close, end, frameFor(mark.expires_at_ms));
    const begin = Math.max(open, start, frameFor(mark.expires_at_ms - FADE_OUT_MS_V1));
    for (let frame = begin; frame <= stop; frame++) boundaries.add(frame);
  };
  layer.initial.marks.forEach(fade);
  collectChangeBoundaries(boundaries, layer.changes, frameFor, fade);
}

function collectChangeBoundaries(boundaries: Set<number>, changes: BoundAnnotationLayer["changes"], frameFor: (atMs: number) => number, fade: (mark: ScreenAnnotationMark) => void): void {
  for (const item of changes) {
    boundaries.add(frameFor(item.atMs));
    if (item.change.kind === "upsert") fade(item.change.mark);
  }
}

function createLayerCursor(layer: BoundAnnotationLayer): LayerCursor {
  const marks = new Map(layer.initial.marks.map((mark) => [mark.draft.mark_id, mark]));
  let presentationVersion = 0;
  const dropExpired = (atMs: number) => {
    for (const [id, mark] of marks) {
      if (mark.expires_at_ms !== null && mark.expires_at_ms <= atMs) {
        marks.delete(id);
        presentationVersion++;
      }
    }
  };
  let paused = layer.initial.paused;
  let next = 0;
  let visible: readonly ScreenAnnotationMark[] = [];
  let cachedVersion = -1;

  const advanceMarks = (atMs: number) => {
    for (let item = layer.changes[next]; item && item.atMs <= atMs; item = layer.changes[next]) {
      next++;
      presentationVersion++;
      dropExpired(item.atMs);
      if (item.change.kind === "control") paused = item.change.paused;
      else applyMarkChange(marks, item.change);
    }
    dropExpired(atMs);
  };

  return {
    layer,
    at(atMs) {
      if (atMs < layer.initial.atMs || atMs >= layer.closedAtMs) return { marks: [], appearance: "" };
      advanceMarks(atMs);
      if (cachedVersion !== presentationVersion) {
        cachedVersion = presentationVersion;
        visible = [...marks.values()].filter((mark) => !paused || mark.author.participant_id === layer.layer.sharer_id);
      }
      return { marks: visible, appearance: appearanceAt(visible, atMs, presentationVersion) };
    },
  };
}

function applyMarkChange(marks: Map<string, ScreenAnnotationMark>, change: Exclude<BoundAnnotationLayer["changes"][number]["change"], { kind: "control" }>): void {
  switch (change.kind) {
    case "upsert":
      marks.set(change.mark.draft.mark_id, change.mark);
      if (marks.size > ACTIVE_MARKS_V1) throw new TypeError("recording annotation sidecar exceeds the active mark bound");
      break;
    case "remove":
      marks.delete(change.mark_id);
      break;
    case "clear":
      clearMarks(marks, change.participant_id);
      break;
  }
}

function clearMarks(marks: Map<string, ScreenAnnotationMark>, participantId: string | null): void {
  if (participantId === null) {
    marks.clear();
    return;
  }
  for (const [id, mark] of marks) {
    if (mark.author.participant_id === participantId) marks.delete(id);
  }
}

function appearanceAt(marks: readonly ScreenAnnotationMark[], atMs: number, version: number): string {
  const fading = marks.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms - atMs < FADE_OUT_MS_V1);
  return fading ? `${version}:${atMs}` : String(version);
}

function appendSpan(spans: SceneSpan[], span: SceneSpan): void {
  const previous = spans.at(-1);
  if (previous?.sceneKey === span.sceneKey) spans[spans.length - 1] = { ...previous, endFrame: span.endFrame };
  else spans.push(span);
}
