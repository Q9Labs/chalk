import { AnnotationTextForm } from "./AnnotationTextForm";
import { CHALK_THEME_TOKENS } from "../../theme";
import {
  frameContainsStroke,
  frameProvesStroke,
  inkHandoff,
  type BakedExportProof,
  type BakedStrokeProof,
  type InkRaster,
  type StrokeProof,
  canvasAnnotationTextMeasure,
  contentRect,
  createAnnotationPresenceTracker,
  framePoint,
  LASER_TRAIL_MS,
  INK_PROOF_TIMEOUT_MS,
  hitTestAnnotation,
  paintAnnotation,
  type AnnotationFit,
  type AnnotationRect,
} from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationCursor, ScreenAnnotationDraft, ScreenAnnotationPresence, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { createBakedVideoSurface } from "./baked-video";
import { loadAnnotationFont } from "./font";
import { addGesturePoint, clampPoint, gestureDraft, localPoint, sameRect, type Gesture } from "./gesture";
import { canDraw, decodedSize, matchesTarget, targetOf, videoMatchesTrack, visibleMarks, type AnnotationAuthor, type AnnotationBrush } from "./model";

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
  readonly input?: {
    readonly actor: AnnotationAuthor;
    readonly brush: AnnotationBrush;
    readonly onCommandError: (message: string) => void;
  };
}

type Preview = {
  readonly draft: ScreenAnnotationDraft;
  readonly author: AnnotationAuthor;
  readonly startedBaked: boolean;
  readonly proof: StrokeProof | null;
  readonly expiresAt: number;
  readonly proofTimeoutAt?: number;
  revision?: number;
};
type ExportSample = { readonly proof: BakedStrokeProof; readonly revision?: number; readonly expiresAt: number };
type TextAnchor = { readonly fence: number; readonly at: ScreenAnnotationCursor["point"]; readonly style: Omit<ScreenAnnotationDraft, "shape"> };

function hasTimeVaryingInk(marks: ScreenAnnotationState["marks"], remote: readonly ScreenAnnotationPresence[], nowMs: number): boolean {
  return marks.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms > nowMs) || remote.some((peer) => peer.expires_at_ms > nowMs);
}

function geometry(canvas: HTMLCanvasElement, video: HTMLVideoElement | null, track: MediaStreamTrack, fit: AnnotationFit) {
  const frame = video && videoMatchesTrack(video, track) ? decodedSize(video) : null;
  if (!frame || !canvas.clientWidth || !canvas.clientHeight) return null;
  const clip: AnnotationRect = { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight };
  const rect = contentRect(frame, clip, fit);
  return rect && { frame, clip, rect };
}

function resetCanvas(context: CanvasRenderingContext2D, clip: AnnotationRect, scale: number): void {
  const { canvas } = context;
  const width = Math.round(clip.width * scale);
  const height = Math.round(clip.height * scale);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.setTransform(width / clip.width, 0, 0, height / clip.height, 0, 0);
  context.clearRect(0, 0, clip.width, clip.height);
}

/** The canvas and video must occupy the same positioned box and use the same fit and transforms. */
export function ScreenAnnotationLayer(props: ScreenAnnotationLayerProps): React.JSX.Element {
  return <LayerCanvas key={`${props.state.layer.layer_id}:${props.state.layer.publication_id}:${props.track.id}`} {...props} />;
}

function LayerCanvas({ client, state, presence, fontUrl, track, videoRef, fit, input, exportProof, bakedFrame }: ScreenAnnotationLayerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const cursor = useRef<ScreenAnnotationCursor | null>(null);
  const localPresenceAt = useRef(0);
  const optimistic = useRef(new Map<string, Preview>());
  const exportSamples = useRef(new Map<string, ExportSample>());
  const videoSurface = useRef<ReturnType<typeof createBakedVideoSurface>>(null);
  const paintCurrent = useRef<() => void>(() => undefined);
  const tracker = useRef(createAnnotationPresenceTracker());
  const refresh = useRef<() => void>(() => undefined);
  const previewUpdate = useRef<number>(-Infinity);
  const [anchor, setTextAnchor] = useState<TextAnchor | null>(null);
  const textAnchor = anchor?.fence === state.fence ? anchor : null;
  const actor = input?.actor;
  const drawing = Boolean(input && actor && canDraw(state, actor.participant_id));
  const target = targetOf(state);
  const baked = state.layer.burned_in === true;

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Keep frame capture attached across Sync and pointer updates.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!baked || !canvas || !video || typeof video.requestVideoFrameCallback !== "function") return;
    const surface = createBakedVideoSurface(canvas.ownerDocument);
    if (!surface) return;
    videoSurface.current = surface;
    let callback = video.requestVideoFrameCallback(onFrame);
    function onFrame() {
      if (!video || !surface) return;
      callback = video.requestVideoFrameCallback(onFrame);
      if (!videoMatchesTrack(video, track) || !decodedSize(video)) return;
      surface.capture(video);
      if (bakedFrame) bakedFrame.current = surface.image();
      paintCurrent.current();
    }
    return () => {
      video.cancelVideoFrameCallback(callback);
      videoSurface.current = null;
      if (bakedFrame) bakedFrame.current = null;
    };
  }, [baked, bakedFrame, track, videoRef]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Release export proofs when Sync removes their marks.
  useEffect(() => {
    exportProof?.reconcile(state.revision, new Set(visibleMarks(state, client.serverNowMs()).map(({ draft }) => draft.mark_id)));
  }, [client, exportProof, state]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Paint the canvas on committed state, geometry, animation and pointer changes; release observers and frames on teardown.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const window = canvas?.ownerDocument.defaultView;
    const context = canvas?.getContext("2d");
    if (!canvas || !window || !context) return;
    let raf = 0;
    const paint = () => {
      window.cancelAnimationFrame(raf);
      raf = 0;
      const mapped = geometry(canvas, video, track, fit);
      if (!mapped) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      const { clip, rect } = mapped;
      resetCanvas(context, clip, window.devicePixelRatio || 1);
      const nowMs = client.serverNowMs();
      const surface = videoSurface.current;
      const decoded = paintBakedFrame(surface, context, rect, clip, nowMs);
      const pending = collectPreviews(decoded, nowMs).map(({ author, draft }) => localSample(author, draft, null));
      function localSample(author: AnnotationAuthor, draft: ScreenAnnotationDraft | null, point: ScreenAnnotationCursor | null): ScreenAnnotationPresence {
        return { type: "annotation_presence", layer_id: state.layer.layer_id, fence: state.fence, author, server_at_ms: localPresenceAt.current, expires_at_ms: nowMs + 1000, cursor: point, draft };
      }
      const peers = presence.filter((peer) => peer.author.participant_id !== actor?.participant_id);
      const remote = baked ? peers.map((peer) => ({ ...peer, draft: null })) : peers;
      const draft = gesture.current ? gestureDraft(gesture.current) : null;
      if (actor && drawing && (cursor.current || draft)) pending.push(localSample(actor, draft, baked ? null : cursor.current));
      const localTouch = state.layer.burned_in && actor && drawing && nowMs - localPresenceAt.current < LASER_TRAIL_MS ? cursor.current?.point : undefined;
      paintAnnotation(context, { rect, clip, sharerId: state.layer.sharer_id, paused: state.paused, marks: state.layer.burned_in ? [] : state.marks, presence: tracker.current.update([...remote, ...pending], nowMs), localTouch, nowMs });
      if (animateAgain(remote, nowMs, localTouch !== undefined)) schedule();
    };
    function animateAgain(remote: readonly ScreenAnnotationPresence[], nowMs: number, touch: boolean) {
      const stillPointing = cursor.current?.tool === "pointer" && nowMs - localPresenceAt.current < LASER_TRAIL_MS;
      return hasTimeVaryingInk(baked ? [] : state.marks, remote, nowMs) || optimistic.current.size > 0 || touch || stillPointing;
    }
    function paintBakedFrame(surface: typeof videoSurface.current, context: CanvasRenderingContext2D, rect: AnnotationRect, clip: AnnotationRect, nowMs: number) {
      const image = surface?.image();
      if (!surface || !image) return null;
      context.fillStyle = CHALK_THEME_TOKENS.stage;
      context.fillRect(0, 0, clip.width, clip.height);
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      trackCommittedInk(surface, nowMs);
      const decoded = optimistic.current.size || exportSamples.current.size ? surface.pixels() : null;
      checkExportSamples(decoded, nowMs);
      return decoded;
    }
    function trackCommittedInk(surface: NonNullable<typeof videoSurface.current>, nowMs: number) {
      if (!baked || !exportProof) return;
      for (const mark of visibleMarks(state, nowMs)) {
        const id = mark.draft.mark_id;
        if (!exportProof.observe(id, mark.created_revision)) continue;
        const proof = surface.proofFor(mark.draft);
        if (proof) exportSamples.current.set(id, { expiresAt: nowMs + INK_PROOF_TIMEOUT_MS, revision: mark.created_revision, proof });
        else exportProof.finish(id);
      }
    }
    function checkExportSamples(decoded: InkRaster | null, nowMs: number) {
      for (const [id, sample] of exportSamples.current) {
        const removed = sample.revision !== undefined && state.revision >= sample.revision && !state.marks.some((mark) => mark.draft.mark_id === id);
        if (!baked || removed || sample.expiresAt <= nowMs) exportSamples.current.delete(id);
        else if (decoded && frameContainsStroke(decoded, sample.proof)) {
          exportProof?.finish(id);
          exportSamples.current.delete(id);
        }
      }
    }
    function collectPreviews(decoded: InkRaster | null, nowMs: number) {
      if (optimistic.current.size === 0) return [];
      const retained: Preview[] = [];
      const marks = new Map(state.marks.map((mark) => [mark.draft.mark_id, mark]));
      for (const [id, preview] of optimistic.current) {
        const committed = marks.get(id);
        preview.revision ??= committed?.created_revision;
        const proved = Boolean(decoded && preview.proof && frameProvesStroke(decoded, preview.proof));
        if (inkHandoff({ baked, revision: state.revision, nowMs, mark: committed, preview, proved }) !== "local") {
          optimistic.current.delete(id);
          continue;
        }
        retained.push(preview);
      }
      return retained;
    }
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
    paintCurrent.current = paint;
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
      paintCurrent.current = () => undefined;
    };
  }, [client, state, presence, fontUrl, track, videoRef, fit, actor, drawing, baked, exportProof]);

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
