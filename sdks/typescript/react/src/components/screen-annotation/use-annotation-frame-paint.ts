import type { ScreenAnnotationClient, ScreenAnnotationCursor, ScreenAnnotationDraft, ScreenAnnotationPresence, ScreenAnnotationState } from "@q9labsai/chalk-client";
import {
  frameContainsStroke,
  frameProvesStroke,
  inkHandoff,
  contentRect,
  createAnnotationPresenceTracker,
  INK_PROOF_TIMEOUT_MS,
  LASER_TRAIL_MS,
  paintAnnotation,
  type AnnotationFit,
  type AnnotationRect,
  type BakedExportProof,
  type BakedStrokeProof,
  type InkRaster,
  type StrokeProof,
} from "@q9labsai/chalk-screen-annotation";
import { useEffect, useRef, type RefObject } from "react";
import { CHALK_THEME_TOKENS } from "../../theme";
import { createBakedVideoSurface } from "./baked-video";
import { loadAnnotationFont } from "./font";
import { gestureDraft, type Gesture } from "./gesture";
import { decodedSize, videoMatchesTrack, visibleMarks, type AnnotationAuthor } from "./model";

export type Preview = {
  readonly draft: ScreenAnnotationDraft;
  readonly author: AnnotationAuthor;
  readonly startedBaked: boolean;
  readonly proof: StrokeProof | null;
  readonly expiresAt: number;
  readonly proofTimeoutAt?: number;
  revision?: number;
};
type ExportSample = { readonly proof: BakedStrokeProof; readonly revision?: number; readonly expiresAt: number };

function hasTimeVaryingInk(marks: ScreenAnnotationState["marks"], remote: readonly ScreenAnnotationPresence[], nowMs: number): boolean {
  return marks.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms > nowMs) || remote.some((peer) => peer.expires_at_ms > nowMs);
}

export function annotationCanvasGeometry(canvas: HTMLCanvasElement, video: HTMLVideoElement | null, track: MediaStreamTrack, fit: AnnotationFit) {
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

type FramePaintOptions = {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly fontUrl?: string;
  readonly track: MediaStreamTrack;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly fit: AnnotationFit;
  readonly actor?: AnnotationAuthor;
  readonly viewerId?: string;
  readonly drawing: boolean;
  readonly baked: boolean;
  readonly exportProof?: BakedExportProof;
  readonly bakedFrame?: RefObject<HTMLCanvasElement | null>;
  readonly gesture: RefObject<Gesture | null>;
  readonly cursor: RefObject<ScreenAnnotationCursor | null>;
  readonly localPresenceAt: RefObject<number>;
  readonly optimistic: RefObject<Map<string, Preview>>;
};

export function useAnnotationFramePaint({ client, state, presence, fontUrl, track, videoRef, fit, actor, viewerId, drawing, baked, exportProof, bakedFrame, gesture, cursor, localPresenceAt, optimistic }: FramePaintOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const exportSamples = useRef(new Map<string, ExportSample>());
  const videoSurface = useRef<ReturnType<typeof createBakedVideoSurface>>(null);
  const paintCurrent = useRef<() => void>(() => undefined);
  const tracker = useRef(createAnnotationPresenceTracker());
  const refresh = useRef<() => void>(() => undefined);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [dom] Keep frame capture attached across Sync and pointer updates.
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

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Release export proofs when Sync removes their marks.
  useEffect(() => {
    exportProof?.reconcile(state.revision, new Set(visibleMarks(state, client.serverNowMs()).map(({ draft }) => draft.mark_id)));
  }, [client, exportProof, state]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [dom] Paint the canvas on committed state, geometry, animation and pointer changes; release observers and frames on teardown.
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
      const mapped = annotationCanvasGeometry(canvas, video, track, fit);
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
      paintAnnotation(context, { rect, clip, sharerId: state.layer.sharer_id, paused: state.paused, marks: state.layer.burned_in ? [] : state.marks, presence: tracker.current.update([...remote, ...pending], nowMs), localTouch, nameMarksExcept: viewerId ?? actor?.participant_id, nowMs });
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
  }, [client, state, presence, fontUrl, track, videoRef, fit, actor, viewerId, drawing, baked, exportProof, gesture, cursor, localPresenceAt, optimistic]);

  return { canvasRef, refresh, videoSurface, exportSamples };
}
