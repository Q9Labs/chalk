import { canvasAnnotationTextMeasure, contentRect, createAnnotationPresenceTracker, framePoint, LASER_TRAIL_MS, hitTestAnnotation, paintAnnotation, type AnnotationFit, type AnnotationRect } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationCursor, ScreenAnnotationDraft, ScreenAnnotationPresence, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { loadAnnotationFont } from "./font";
import { addGesturePoint, clampPoint, gestureDraft, localPoint, sameRect, type Gesture } from "./gesture";
import { canDraw, decodedSize, matchesTarget, targetOf, videoMatchesTrack, type AnnotationAuthor, type AnnotationBrush } from "./model";

export interface ScreenAnnotationLayerProps {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly fontUrl?: string;
  readonly track: MediaStreamTrack;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly fit: AnnotationFit;
  readonly input?: {
    readonly actor: AnnotationAuthor;
    readonly brush: AnnotationBrush;
    readonly onCommandError: (message: string) => void;
  };
}

type Preview = { readonly draft: ScreenAnnotationDraft; readonly expiresAt: number; readonly revision?: number };
type TextAnchor = { readonly at: ScreenAnnotationCursor["point"]; readonly style: Omit<ScreenAnnotationDraft, "shape"> };

function geometry(canvas: HTMLCanvasElement, video: HTMLVideoElement | null, track: MediaStreamTrack, fit: AnnotationFit) {
  const frame = video && videoMatchesTrack(video, track) ? decodedSize(video) : null;
  if (!frame || !canvas.clientWidth || !canvas.clientHeight) return null;
  const clip: AnnotationRect = { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight };
  const rect = contentRect(frame, clip, fit);
  return rect && { frame, clip, rect };
}

/** The canvas and video must occupy the same positioned box and use the same fit and transforms. */
export function ScreenAnnotationLayer(props: ScreenAnnotationLayerProps): React.JSX.Element {
  return <LayerCanvas key={`${props.state.layer.layer_id}:${props.state.fence}`} {...props} />;
}

function LayerCanvas({ client, state, presence, fontUrl, track, videoRef, fit, input }: ScreenAnnotationLayerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const cursor = useRef<ScreenAnnotationCursor | null>(null);
  const localPresenceAt = useRef(0);
  const optimistic = useRef<Preview | null>(null);
  const tracker = useRef(createAnnotationPresenceTracker());
  const refresh = useRef<() => void>(() => undefined);
  const previewUpdate = useRef<number>(-Infinity);
  const [textAnchor, setTextAnchor] = useState<TextAnchor | null>(null);
  const actor = input?.actor;
  const drawing = Boolean(input && actor && canDraw(state, actor.participant_id));
  const target = targetOf(state);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Paint the canvas on committed state, geometry, animation and pointer changes; release observers and frames on teardown.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const window = canvas?.ownerDocument.defaultView;
    const context = canvas?.getContext("2d");
    if (!canvas || !window || !context) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const mapped = geometry(canvas, video, track, fit);
      if (!mapped) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      const { clip, rect } = mapped;
      const scale = window.devicePixelRatio || 1;
      const width = Math.round(clip.width * scale);
      const height = Math.round(clip.height * scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.setTransform(width / clip.width, 0, 0, height / clip.height, 0, 0);
      context.clearRect(0, 0, clip.width, clip.height);
      const nowMs = client.serverNowMs();
      const preview = optimistic.current;
      if (preview && (preview.expiresAt <= nowMs || (preview.revision !== undefined && state.revision >= preview.revision) || state.marks.some((mark) => mark.draft.mark_id === preview.draft.mark_id))) optimistic.current = null;
      const ownDraft = gesture.current ? gestureDraft(gesture.current) : (optimistic.current?.draft ?? null);
      const remote = state.layer.burned_in ? [] : presence.filter((peer) => peer.author.participant_id !== actor?.participant_id);
      const local =
        actor && drawing && (cursor.current || ownDraft)
          ? [
              {
                type: "annotation_presence",
                layer_id: state.layer.layer_id,
                fence: state.fence,
                author: actor,
                server_at_ms: localPresenceAt.current,
                expires_at_ms: nowMs + 1000,
                cursor: state.layer.burned_in ? null : cursor.current,
                draft: ownDraft,
              } satisfies ScreenAnnotationPresence,
            ]
          : [];
      const localTouch = state.layer.burned_in && actor && drawing && nowMs - localPresenceAt.current < LASER_TRAIL_MS
        ? cursor.current?.point : undefined;
      paintAnnotation(context, { rect, clip, sharerId: state.layer.sharer_id, paused: state.paused, marks: state.layer.burned_in ? [] : state.marks, presence: tracker.current.update([...remote, ...local], nowMs), localTouch, nowMs });
      const expiring = state.marks.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms > nowMs) || remote.some((peer) => peer.expires_at_ms > nowMs);
      if (expiring || optimistic.current || localTouch || (cursor.current?.tool === "pointer" && nowMs - localPresenceAt.current < LASER_TRAIL_MS)) schedule();
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(paint);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    video?.addEventListener("loadeddata", schedule);
    video?.addEventListener("resize", schedule);
    video?.addEventListener("emptied", schedule);
    video?.addEventListener("playing", schedule);
    window.addEventListener("resize", schedule);
    refresh.current = schedule;
    schedule();
    let active = true;
    void loadAnnotationFont(canvas.ownerDocument, fontUrl).then(
      () => {
        if (active) schedule();
      },
      () => undefined,
    );
    return () => {
      active = false;
      observer.disconnect();
      video?.removeEventListener("loadeddata", schedule);
      video?.removeEventListener("resize", schedule);
      video?.removeEventListener("emptied", schedule);
      video?.removeEventListener("playing", schedule);
      window.removeEventListener("resize", schedule);
      window.cancelAnimationFrame(raf);
      refresh.current = () => undefined;
    };
  }, [client, state, presence, fontUrl, track, videoRef, fit, actor, drawing]);

  const { layerId, fence } = target;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Cancel latest-value presence and input on disable or when the gesture's authority is retired.
  useEffect(() => {
    if (!drawing) return;
    return () => {
      gesture.current = null;
      cursor.current = null;
      optimistic.current = null;
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
  const send = async (command: ScreenAnnotationCommand) => {
    if (!input || !actor) return;
    const live = matchesTarget(client, target);
    if (!live || !canDraw(live, actor.participant_id)) return;
    const preview = command.kind === "commit" ? { draft: command.draft, expiresAt: client.serverNowMs() + 1000 } : null;
    if (preview) optimistic.current = preview;
    refresh.current();
    try {
      const result = await client.dispatch(target, command);
      if (preview && optimistic.current === preview) optimistic.current = result.kind === "accepted" ? { ...preview, revision: result.revision } : null;
      if (result.kind !== "accepted" && matchesTarget(client, target)) input.onCommandError("The mark could not be applied.");
    } catch {
      if (optimistic.current === preview) optimistic.current = null;
      if (matchesTarget(client, target)) input.onCommandError("The mark could not be applied.");
    }
    refresh.current();
  };
  const pointFrom = (event: PointerEvent<HTMLCanvasElement>, clamp = false) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const mapped = geometry(event.currentTarget, videoRef.current, track, fit);
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
            setTextAnchor({ at: point, style });
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

function AnnotationTextForm({ onClose, onApply }: { readonly onClose: () => void; readonly onApply: (text: string, note: boolean) => void }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState(false);
  const tooLong = new TextEncoder().encode(text.trim()).length > 512;
  return (
    <form
      className="absolute inset-x-3 top-3 z-30 mx-auto grid max-w-sm gap-2 rounded-lg bg-[var(--chalk-overlay-strong)] p-3 text-[var(--chalk-on-overlay)]"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() && !tooLong) onApply(text.trim(), note);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="grid gap-1">
        Annotation text
        <input autoFocus className="rounded bg-[var(--chalk-tile)] px-2 py-1 text-[var(--chalk-text)]" value={text} maxLength={512} onChange={(event) => setText(event.target.value)} />
      </label>
      {tooLong ? <span role="status">This text is too long for a mark.</span> : null}
      <label className="flex gap-2">
        <input type="checkbox" checked={note} onChange={(event) => setNote(event.target.checked)} /> Note background
      </label>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={!text.trim() || tooLong}>
          Add text
        </button>
      </div>
    </form>
  );
}
