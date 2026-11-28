import { AnnotationTextForm } from "./AnnotationTextForm";
import { type BakedExportProof, canvasAnnotationTextMeasure, framePoint, INK_PROOF_TIMEOUT_MS, hitTestAnnotation, type AnnotationFit } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationCursor, ScreenAnnotationDraft, ScreenAnnotationPresence, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { annotationCanvasGeometry, useAnnotationFramePaint, type Preview } from "./use-annotation-frame-paint";
import { addGesturePoint, clampPoint, gestureDraft, localPoint, sameRect, type Gesture } from "./gesture";
import { canDraw, matchesTarget, targetOf, type AnnotationAuthor, type AnnotationBrush } from "./model";

export interface ScreenAnnotationLayerProps {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly fontUrl?: string;
  readonly track: MediaStreamTrack;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly fit: AnnotationFit;
  readonly exportProof?: BakedExportProof;
  readonly bakedFrame?: RefObject<HTMLCanvasElement | null>;
  /** Whose marks are not named: the person looking at the share. */
  readonly viewerId?: string;
  readonly input?: {
    readonly actor: AnnotationAuthor;
    readonly brush: AnnotationBrush;
    readonly onCommandError: (message: string) => void;
  };
}

type TextAnchor = { readonly fence: number; readonly at: ScreenAnnotationCursor["point"]; readonly style: Omit<ScreenAnnotationDraft, "shape"> };

/** The canvas and video must occupy the same positioned box and use the same fit and transforms. */
export function ScreenAnnotationLayer(props: ScreenAnnotationLayerProps): React.JSX.Element {
  return <LayerCanvas key={`${props.state.layer.layer_id}:${props.state.layer.publication_id}:${props.track.id}`} {...props} />;
}

function LayerCanvas({ client, state, presence, fontUrl, track, videoRef, fit, input, exportProof, bakedFrame, viewerId }: ScreenAnnotationLayerProps): React.JSX.Element {
  const gesture = useRef<Gesture | null>(null);
  const cursor = useRef<ScreenAnnotationCursor | null>(null);
  const localPresenceAt = useRef(0);
  const optimistic = useRef(new Map<string, Preview>());
  const previewUpdate = useRef<number>(-Infinity);
  const [anchor, setTextAnchor] = useState<TextAnchor | null>(null);
  const textAnchor = anchor?.fence === state.fence ? anchor : null;
  const actor = input?.actor;
  const drawing = Boolean(input && actor && canDraw(state, actor.participant_id));
  const target = targetOf(state);
  const baked = state.layer.burned_in === true;

  const { canvasRef, refresh, videoSurface, exportSamples } = useAnnotationFramePaint({ client, state, presence, fontUrl, track, videoRef, fit, actor, viewerId, drawing, baked, exportProof, bakedFrame, gesture, cursor, localPresenceAt, optimistic });

  const { layerId, fence } = target;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Cancel latest-value presence and input on disable or when the gesture's authority is retired.
  useEffect(() => {
    if (!drawing) return;
    return () => {
      gesture.current = null;
      cursor.current = null;
      const previous = { layerId, fence };
      if (matchesTarget(client, previous)) client.setPresence(previous, null, null);
    };
  }, [client, drawing, layerId, fence]);

  const publish = (force = false) => {
    localPresenceAt.current = client.serverNowMs();
    const now = performance.now();
    if (matchesTarget(client, target) && (force || now - previewUpdate.current >= 1000 / 30)) {
      previewUpdate.current = now;
      client.setPresence(target, cursor.current, gesture.current ? gestureDraft(gesture.current) : null);
    }
    refresh.current();
  };
  const cancel = () => {
    gesture.current = null;
    cursor.current = null;
    publish(true);
  };
  function showPreview(draft: ScreenAnnotationDraft, author: AnnotationAuthor): Preview {
    const surface = videoSurface.current;
    const proof = baked ? surface?.proofFor(draft) : undefined;
    const preview: Preview = {
      draft,
      author,
      startedBaked: baked,
      proof: proof?.changed ?? null,
      expiresAt: client.serverNowMs() + 1000,
      proofTimeoutAt: baked ? client.serverNowMs() + INK_PROOF_TIMEOUT_MS : undefined,
    };
    const id = preview.draft.mark_id;
    optimistic.current.set(id, preview);
    if (baked) {
      if (proof) {
        exportProof?.expect(id);
        exportSamples.current.set(id, { expiresAt: client.serverNowMs() + INK_PROOF_TIMEOUT_MS, proof });
      } else if (proof === null) {
        exportProof?.expect(id);
        exportProof?.finish(id);
      }
    }
    return preview;
  }
  function settlePreview(preview: Preview, result: Awaited<ReturnType<ScreenAnnotationClient["dispatch"]>>) {
    const id = preview.draft.mark_id;
    if (result.kind === "accepted") {
      preview.revision = result.revision;
      const sample = exportSamples.current.get(id);
      if (sample) exportSamples.current.set(id, { ...sample, revision: result.revision });
      exportProof?.accepted(id, result.revision);
      return;
    }
    if (result.kind !== "delivery_unknown") {
      exportSamples.current.delete(id);
      exportProof?.settle(id);
    }
    if (optimistic.current.get(id) === preview) optimistic.current.delete(id);
  }
  const send = async (command: ScreenAnnotationCommand) => {
    if (!input || !actor) return;
    const live = matchesTarget(client, target);
    if (!live || !canDraw(live, actor.participant_id)) return;
    const preview = command.kind === "commit" ? showPreview(command.draft, actor) : null;
    refresh.current();
    try {
      const result = await client.dispatch(target, command);
      if (preview) settlePreview(preview, result);
      if (result.kind !== "accepted" && matchesTarget(client, target)) input.onCommandError("The mark could not be applied.");
    } catch {
      if (preview && optimistic.current.get(preview.draft.mark_id) === preview) optimistic.current.delete(preview.draft.mark_id);
      if (matchesTarget(client, target)) input.onCommandError("The mark could not be applied.");
    }
    refresh.current();
  };
  const pointFrom = (event: PointerEvent<HTMLCanvasElement>, clamp = false) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const mapped = annotationCanvasGeometry(event.currentTarget, videoRef.current, track, fit);
    if (!mapped || !bounds.width || !bounds.height) return null;
    const point = localPoint(bounds, mapped.clip, event);
    const normalized = framePoint(mapped.rect, clamp ? clampPoint(mapped.rect, clampPoint(mapped.clip, point)) : point);
    return normalized && { ...mapped, point: normalized, cssPoint: point };
  };
  const currentInput = () => {
    if (!input || !drawing || !actor) return null;
    const live = matchesTarget(client, target);
    return live && canDraw(live, actor.participant_id) ? live : null;
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        data-part="screen-annotation-layer"
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: drawing ? "auto" : "none", touchAction: drawing ? "none" : undefined, cursor: drawing ? (input?.brush.tool === "text" ? "text" : "crosshair") : undefined }}
        onPointerDown={(event) => {
          const live = currentInput();
          if (!live || !input || !actor || !event.isPrimary || event.button !== 0 || textAnchor || gesture.current) return;
          const mapped = pointFrom(event);
          if (!mapped) return;
          event.stopPropagation();
          const { brush } = input;
          const { point, rect, clip, cssPoint } = mapped;
          if (brush.tool === "pointer") {
            cursor.current = { point, tool: "pointer" };
            publish(true);
            return;
          }
          if (brush.tool === "eraser") {
            const context = event.currentTarget.getContext("2d");
            if (!context) return;
            const hit = hitTestAnnotation(cssPoint, {
              rect,
              clip,
              marks: live.marks,
              paused: live.paused,
              sharerId: live.layer.sharer_id,
              nowMs: client.serverNowMs(),
              measureText: canvasAnnotationTextMeasure(context),
              canErase: (mark) => live.access.can_moderate || mark.author.participant_id === actor.participant_id,
            });
            if (hit) void send({ kind: "erase", mark_id: hit.draft.mark_id });
            return;
          }
          const style: Omit<ScreenAnnotationDraft, "shape"> = {
            mark_id: crypto.randomUUID(),
            lifetime: brush.keep ? "keep" : "fade",
            color: brush.color ?? live.access.default_color,
            width: brush.width,
          };
          if (brush.tool === "text") {
            setTextAnchor({ fence: live.fence, at: point, style });
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = { pointerId: event.pointerId, target, rect, clip, style, tool: brush.tool, stamp: brush.stamp, points: [point] };
          cursor.current = { point, tool: "ink" };
          publish(true);
        }}
        onPointerMove={(event) => {
          if (!currentInput() || !event.isPrimary) return;
          const draft = gesture.current;
          const mapped = pointFrom(event, Boolean(draft));
          if (draft && (draft.pointerId !== event.pointerId || !mapped || !sameRect(draft.rect, mapped.rect) || !sameRect(draft.clip, mapped.clip))) {
            cancel();
            return;
          }
          if (draft && mapped) addGesturePoint(draft, mapped.point);
          cursor.current = mapped ? { point: mapped.point, tool: input?.brush.tool === "pointer" ? "pointer" : "ink" } : null;
          publish(!mapped);
        }}
        onPointerUp={(event) => {
          const draft = gesture.current;
          if (!draft || draft.pointerId !== event.pointerId) return;
          event.stopPropagation();
          const mapped = pointFrom(event, true);
          if (currentInput() && matchesTarget(client, draft.target) && mapped && sameRect(draft.rect, mapped.rect) && sameRect(draft.clip, mapped.clip)) {
            addGesturePoint(draft, mapped.point);
            void send({ kind: "commit", draft: gestureDraft(draft) });
          }
          cancel();
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (gesture.current) cancel();
        }}
        onPointerLeave={() => {
          if (!gesture.current) cancel();
        }}
        onDoubleClick={(event) => {
          if (drawing) event.stopPropagation();
        }}
      />
      {drawing && textAnchor ? (
        <AnnotationTextForm
          onClose={() => setTextAnchor(null)}
          onApply={(text, note) => {
            setTextAnchor(null);
            void send({ kind: "commit", draft: { ...textAnchor.style, shape: { kind: "text", at: textAnchor.at, text, note } } });
          }}
        />
      ) : null}
    </>
  );
}
