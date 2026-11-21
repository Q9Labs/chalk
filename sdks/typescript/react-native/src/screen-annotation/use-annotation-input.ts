import type {
  ScreenAnnotationClient,
  ScreenAnnotationCursor,
  ScreenAnnotationDraft,
  ScreenAnnotationPoint,
  ScreenAnnotationPresence,
  ScreenAnnotationTarget,
} from "@q9labsai/chalk-client";
import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import type { GestureResponderEvent, NativeTouchEvent } from "react-native";
import type { Frame } from "../motion/MovingFrame";
import { canCapture, framePoint, hasTarget, matchLayer, pinchViewport, targetFor, type Ink, type Viewport } from "./model";

export type TextAnchor = {
  readonly target: ScreenAnnotationTarget;
  readonly at: ScreenAnnotationPoint;
  readonly draft: Omit<ScreenAnnotationDraft, "shape">;
};

type Drawing = {
  readonly pointer: NativeTouchEvent["identifier"];
  readonly target: ScreenAnnotationTarget;
  readonly ink: Ink;
  readonly draft: Omit<ScreenAnnotationDraft, "shape">;
  readonly start: ScreenAnnotationPoint;
  readonly rect: Frame;
  points: readonly ScreenAnnotationPoint[];
  sentAt: number;
};

type Pinch = {
  readonly center: ScreenAnnotationPoint;
  readonly distance: number;
  readonly rect: Frame;
  readonly viewport: Viewport;
};

function position(touch: NativeTouchEvent): ScreenAnnotationPoint {
  return { x: touch.locationX, y: touch.locationY };
}

function pinch(touches: readonly NativeTouchEvent[]) {
  const [one, two] = touches;
  if (!one || !two) return null;
  return {
    center: { x: (one.locationX + two.locationX) / 2, y: (one.locationY + two.locationY) / 2 },
    distance: Math.max(1, Math.hypot(one.locationX - two.locationX, one.locationY - two.locationY)),
  };
}

function samplePoints(points: readonly ScreenAnnotationPoint[], point: ScreenAnnotationPoint): readonly ScreenAnnotationPoint[] {
  const last = points.at(-1);
  if (last?.x === point.x && last.y === point.y) return points;
  if (points.length < 384) return [...points, point];
  return [...points.filter((_, index) => index % 2 === 0), point];
}

function preview(drawing: Drawing, point: ScreenAnnotationPoint): ScreenAnnotationDraft | null {
  const { tool } = drawing.ink;
  switch (tool) {
    case "laser":
    case "eraser":
    case "text":
      return null;
    case "stamp":
      return { ...drawing.draft, shape: { kind: "stamp", at: point, stamp: drawing.ink.stamp } };
    case "pen":
    case "highlighter":
      drawing.points = samplePoints(drawing.points, point);
      return { ...drawing.draft, shape: { kind: tool, points: drawing.points.length === 1 ? [point, point] : drawing.points } };
    case "line":
    case "arrow":
    case "box":
    case "circle":
      return { ...drawing.draft, shape: { kind: tool, from_point: drawing.start, to_point: point } };
  }
}

export function useAnnotationInput({
  client, publicationId, participantId, displayName, color, ink, rect, viewport, onViewport, onText, onErase, onCommit,
}: {
  readonly client: ScreenAnnotationClient;
  readonly publicationId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly color: string;
  readonly ink: Ink;
  readonly rect: Frame;
  readonly viewport: Viewport;
  readonly onViewport: (pan: Viewport) => void;
  readonly onText: (anchor: TextAnchor) => void;
  readonly onErase: (point: ScreenAnnotationPoint, target: ScreenAnnotationTarget) => void;
  readonly onCommit: (draft: ScreenAnnotationDraft, target: ScreenAnnotationTarget) => void;
}) {
  const active = useRef<Drawing | null>(null);
  const panning = useRef<Pinch | null>(null);
  const gestureClaimed = useRef(false);
  const [local, setLocal] = useState<ScreenAnnotationPresence | null>(null);
  const current = () => matchLayer(client, publicationId);

  function finish() {
    const drawing = active.current;
    active.current = null;
    setLocal(null);
    if (drawing && hasTarget(current(), drawing.target)) client.setPresence(drawing.target, null, null);
  }

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] End the old publication's presence when the surface is removed.
  useEffect(() => () => {
    const drawing = active.current;
    if (drawing) client.setPresence(drawing.target, null, null);
  }, [client, publicationId]);

  function publish(drawing: Drawing, point: ScreenAnnotationPoint) {
    const draft = preview(drawing, point);
    const cursor: ScreenAnnotationCursor = { point, tool: drawing.ink.tool === "laser" ? "pointer" : "ink" };
    const nowMs = client.serverNowMs();
    setLocal({
      type: "annotation_presence",
      layer_id: drawing.target.layerId,
      fence: drawing.target.fence,
      author: { participant_id: participantId, display_name: displayName, color },
      server_at_ms: nowMs,
      expires_at_ms: nowMs + 1000,
      cursor,
      draft,
    });
    if (nowMs - drawing.sentAt >= 1000 / 30) {
      drawing.sentAt = nowMs;
      client.setPresence(drawing.target, cursor, draft);
    }
  }

  function onStart({ nativeEvent }: GestureResponderEvent) {
    const { touches } = nativeEvent;
    const pair = pinch(touches);
    if (pair) {
      finish();
      gestureClaimed.current = true;
      panning.current = { ...pair, rect, viewport };
      return;
    }
    const [touch] = touches;
    const state = current();
    if (!touch || gestureClaimed.current || !state || !canCapture(state, participantId)) return;
    const point = framePoint(rect, position(touch), false);
    if (!point) return;

    const drawing: Drawing = {
      pointer: touch.identifier,
      target: targetFor(state),
      ink,
      draft: { mark_id: randomUUID(), lifetime: ink.lifetime, color: ink.color, width: ink.width },
      start: point,
      rect,
      points: [point],
      sentAt: -Infinity,
    };
    active.current = drawing;
    if (ink.tool !== "text" && ink.tool !== "eraser") publish(drawing, point);
  }

  function onMove({ nativeEvent }: GestureResponderEvent) {
    const pair = pinch(nativeEvent.touches);
    if (pair) {
      const origin = panning.current;
      if (origin) onViewport(pinchViewport(origin.rect, origin.viewport, origin.center, pair.center, pair.distance / origin.distance));
      return;
    }
    const drawing = active.current;
    if (!drawing) return;
    const state = current();
    if (!hasTarget(state, drawing.target) || !canCapture(state, participantId) || !sameRect(rect, drawing.rect)) {
      finish();
      return;
    }
    const touch = nativeEvent.touches.find(({ identifier }) => identifier === drawing.pointer);
    if (!touch || drawing.ink.tool === "text" || drawing.ink.tool === "eraser") return;
    const point = framePoint(drawing.rect, position(touch), true);
    if (point) publish(drawing, point);
  }

  function onEnd({ nativeEvent }: GestureResponderEvent) {
    if (nativeEvent.touches.length === 0) {
      gestureClaimed.current = false;
      panning.current = null;
    }
    const drawing = active.current;
    const touch = drawing && nativeEvent.changedTouches.find(({ identifier }) => identifier === drawing.pointer);
    if (!drawing || !touch) return;
    const state = current();
    finish();
    if (!hasTarget(state, drawing.target) || !canCapture(state, participantId) || !sameRect(rect, drawing.rect)) return;
    const location = position(touch);
    const point = framePoint(drawing.rect, location, true);
    if (!point) return;
    if (drawing.ink.tool === "text") {
      onText({ target: drawing.target, at: point, draft: drawing.draft });
    } else if (drawing.ink.tool === "eraser") {
      onErase(location, drawing.target);
    } else {
      const draft = preview(drawing, point);
      if (draft) onCommit(draft, drawing.target);
    }
  }

  function cancel() {
    finish();
    panning.current = null;
    gestureClaimed.current = false;
  }

  return { local, onStart, onMove, onEnd, cancel };
}

function sameRect(a: Frame, b: Frame): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
