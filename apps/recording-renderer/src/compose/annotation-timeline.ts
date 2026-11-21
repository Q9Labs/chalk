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
  const bySource = new Map<string, LayerCursor[]>();
  for (const layer of layers) {
    if (!layer.initial.marks.length && !layer.changes.some(({ change }) => change.kind === "upsert")) continue;
    const cursor = createLayerCursor(layer);
    for (const sourceId of layer.sourceIds) {
      const entries = bySource.get(sourceId) ?? [];
      entries.push(cursor);
      bySource.set(sourceId, entries);
    }
  }

  const firstFrame = (atMs: number): number => Math.ceil((atMs * fps) / 1_000);
  return {
    sourceFor(segment: VideoSegment) {
      for (const tile of segment.spans[0]?.scene.tiles ?? []) {
        if (tile.kind !== "screen_share" || tile.video === undefined) continue;
        const layers = bySource.get(tile.video.sourceId);
        if (layers?.some(({ layer }) => firstFrame(layer.closedAtMs) > segment.startFrame && firstFrame(layer.initial.atMs) < segment.endFrame)) return tile.video.sourceId;
      }
      return undefined;
    },
    apply(segment: VideoSegment, sourceId: string, decodedStartMs: number, geometry: readonly AnnotationGeometry[]): VideoSegment {
      const cursors = bySource.get(sourceId) ?? [];
      const startFrame = Math.max(segment.startFrame, firstFrame(decodedStartMs));
      const boundaries = new Set<number>([startFrame]);
      for (const item of geometry) boundaries.add(item.frame);
      for (const { layer } of cursors) collectBoundaries(boundaries, layer, startFrame, segment.endFrame, firstFrame);
      const frames = [...boundaries].filter((frame) => frame >= startFrame && frame < segment.endFrame).sort((left, right) => left - right);
      const spans: SceneSpan[] = [];
      let nextFrame = 0;
      let geometryIndex = 0;
      let cursorIndex = 0;
      for (const span of segment.spans) {
        for (let frame = span.startFrame; frame < span.endFrame; ) {
          while (frames[nextFrame] !== undefined && frames[nextFrame]! <= frame) nextFrame++;
          while (geometry[geometryIndex + 1] !== undefined && geometry[geometryIndex + 1]!.frame <= frame) geometryIndex++;
          const endFrame = Math.min(span.endFrame, frames[nextFrame] ?? span.endFrame);
          const atMs = Math.floor((frame * 1_000) / fps);
          while (cursors[cursorIndex] !== undefined && cursors[cursorIndex]!.layer.closedAtMs <= atMs) cursorIndex++;
          const cursor = cursors[cursorIndex];
          const rect = geometry[geometryIndex]?.content;
          const visible = frame >= startFrame ? cursor?.at(atMs) : undefined;
          if (visible === undefined || !visible.marks.length || rect === undefined) {
            appendSpan(spans, { ...span, startFrame: frame, endFrame });
          } else {
            const tiles = span.scene.tiles.map((tile) => (tile.kind === "screen_share" && tile.video?.sourceId === sourceId ? { ...tile, annotation: { content: rect, marks: visible.marks, atMs } } : tile));
            const scene = { ...span.scene, tiles };
            appendSpan(spans, { startFrame: frame, endFrame, scene, sceneKey: JSON.stringify([span.sceneKey, cursor?.layer.layer.layer_id, visible.appearance, rect]) });
          }
          frame = endFrame;
        }
      }
      return { ...segment, spans };
    },
  };
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
  for (const item of layer.changes) {
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
  return {
    layer,
    at(atMs) {
      if (atMs < layer.initial.atMs || atMs >= layer.closedAtMs) return { marks: [], appearance: "" };
      while (next < layer.changes.length) {
        const item = layer.changes[next]!;
        if (item.atMs > atMs) break;
        next++;
        presentationVersion++;
        const change = item.change;
        dropExpired(item.atMs);
        switch (change.kind) {
          case "upsert":
            marks.set(change.mark.draft.mark_id, change.mark);
            if (marks.size > ACTIVE_MARKS_V1) throw new TypeError("recording annotation sidecar exceeds the active mark bound");
            break;
          case "remove":
            marks.delete(change.mark_id);
            break;
          case "clear":
            if (change.participant_id === null) marks.clear();
            else for (const [id, mark] of marks) if (mark.author.participant_id === change.participant_id) marks.delete(id);
            break;
          case "control":
            paused = change.paused;
            break;
        }
      }
      dropExpired(atMs);
      if (cachedVersion !== presentationVersion) {
        cachedVersion = presentationVersion;
        visible = [...marks.values()].filter((mark) => !paused || mark.author.participant_id === layer.layer.sharer_id);
      }
      const fading = visible.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms - atMs < FADE_OUT_MS_V1);
      return { marks: visible, appearance: fading ? `${presentationVersion}:${atMs}` : String(presentationVersion) };
    },
  };
}

function appendSpan(spans: SceneSpan[], span: SceneSpan): void {
  const previous = spans.at(-1);
  if (previous?.sceneKey === span.sceneKey) spans[spans.length - 1] = { ...previous, endFrame: span.endFrame };
  else spans.push(span);
}
