import { captureAnnotationVideoFrame, type AnnotationFit } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationPresence, ScreenAnnotationState, ScreenAnnotationTarget, ScreenShareCapture, WhiteboardSlice } from "@q9labsai/chalk-client";
import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { StageIcon } from "../stage/StageIcon";
import { AnnotationAccess, annotationControl, type AnnotationPerson } from "./AnnotationAccess";
import { AnnotationPictureInPicture } from "./AnnotationPictureInPicture";
import { AnnotationTabCue } from "./AnnotationTabCue";
import { AnnotationHelperOffer } from "./AnnotationHelperOffer";
import { ScreenAnnotationLayer } from "./ScreenAnnotationLayer";
import { ScreenAnnotationToolbar } from "./ScreenAnnotationToolbar";
import { canDraw, defaultBrush, matchesTarget, targetOf, videoMatchesTrack, type ScreenAnnotationActions, type ScreenAnnotationFrame, type ScreenAnnotationOptions, type ScreenAnnotationHelper } from "./model";

export interface AnnotationPresentationContext {
  readonly actorId: string;
  readonly actorName: string;
  readonly people?: readonly AnnotationPerson[];
  readonly grants?: WhiteboardSlice["access"]["permissions"];
}

type SurfaceProps = AnnotationPresentationContext & {
  readonly annotation: ScreenAnnotationOptions;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly canvasHost: HTMLDivElement | null;
  readonly fit: AnnotationFit;
  readonly track: MediaStreamTrack;
  readonly primary: boolean;
  readonly live: boolean;
  readonly isLocal: boolean;
  readonly capture?: ScreenShareCapture;
};

const noPeople: readonly AnnotationPerson[] = [];

export function AnnotationSurface({ annotation, ...props }: SurfaceProps): React.JSX.Element | null {
  const { client, publicationId, actions, fontUrl, helper } = annotation;
  const snapshot = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  );
  const state = snapshot.status === "ready" ? snapshot.state : null;
  if (snapshot.status !== "ready" || !state || state.layer.publication_id !== publicationId || !props.live) return null;
  return <ActiveAnnotationSurface key={state.layer.layer_id} {...props} client={client} fontUrl={fontUrl} helper={helper} actions={actions} state={state} presence={snapshot.presence} />;
}

function ActiveAnnotationSurface({
  client,
  state,
  presence,
  fontUrl,
  helper,
  actions,
  videoRef,
  canvasHost,
  fit,
  track,
  primary,
  isLocal,
  capture,
  actorId,
  actorName,
  people = noPeople,
  grants,
}: Omit<SurfaceProps, "annotation" | "live"> & {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly fontUrl?: string;
  readonly helper?: ScreenAnnotationHelper;
  readonly actions?: ScreenAnnotationActions;
}): React.JSX.Element {
  const [brush, setBrush] = useState(defaultBrush);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const boardRetry = useRef<{ frame: ScreenAnnotationFrame; target: ScreenAnnotationTarget; action: NonNullable<ScreenAnnotationActions["saveToWhiteboard"]> } | null>(null);
  const target = targetOf(state);
  const { saveToWhiteboard, downloadPng } = actions ?? {};
  const editable = canDraw(state, actorId);
  // A webpage cannot exclude its own windows from monitor capture. Keep them clean by default.
  const safePreview = !isLocal || capture?.surface === "browser" || capture?.surface === "window";
  const showToolbar = toolsOpen && editable && safePreview;
  const showOwnClear = state.marks.some((mark) => mark.author.participant_id === actorId);
  const onError = (message: string) => setFeedback({ message, error: true });

  const command = async (command: ScreenAnnotationCommand) => {
    setFeedback(null);
    try {
      const result = await client.dispatch(target, command);
      if (result.kind !== "accepted" && matchesTarget(client, target)) onError("The annotation action could not be applied.");
    } catch {
      if (matchesTarget(client, target)) onError("The annotation action could not be applied.");
    }
  };
  const exportFrame = async (action: NonNullable<ScreenAnnotationActions["saveToWhiteboard"]>, toBoard: boolean) => {
    if (saving.current) return;
    const live = matchesTarget(client, target);
    const video = videoRef.current;
    if (!live || !video || !videoMatchesTrack(video, track) || !canDraw(live, actorId)) return;
    saving.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const retry = toBoard && boardRetry.current?.action === action && boardRetry.current.target.fence === target.fence ? boardRetry.current : null;
      const frame =
        retry?.frame ??
        captureAnnotationVideoFrame(video, {
          publicationId: live.layer.publication_id,
          marks: live.marks,
          paused: live.paused,
          sharerId: live.layer.sharer_id,
          nowMs: client.serverNowMs(),
        });
      if (toBoard) boardRetry.current = { frame, action, target };
      await action(frame);
      if (toBoard) boardRetry.current = null;
      setFeedback({ message: toBoard ? "Frame saved to the board." : "PNG downloaded.", error: false });
    } catch {
      onError("The annotated frame could not be saved.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const annotationProps = { client, state, presence, fontUrl };
  return (
    <>
      {safePreview && canvasHost
        ? createPortal(
            <ScreenAnnotationLayer {...annotationProps} videoRef={videoRef} track={track} fit={fit} input={primary && showToolbar ? { actor: { participant_id: actorId, display_name: actorName, color: state.access.default_color }, brush, onCommandError: onError } : undefined} />,
            canvasHost,
          )
        : null}
      {primary ? (
        <div data-part="screen-annotation-controls" className="pointer-events-none absolute inset-x-2 bottom-12 z-30 grid justify-items-center gap-1.5">
          <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5">
            {editable && safePreview ? (
              <button type="button" className={annotationControl} aria-expanded={showToolbar} onClick={() => setToolsOpen(!toolsOpen)}>
                <StageIcon name="pen" size={14} /> {showToolbar ? "Hide tools" : "Annotate"}
              </button>
            ) : null}
            <AnnotationAccess client={client} state={state} actorId={actorId} people={people} grants={grants} command={(action) => void command(action)} />
            {isLocal && safePreview ? <AnnotationPictureInPicture {...annotationProps} track={track} /> : null}
          </div>
          {isLocal && !safePreview ? <p className={annotationControl}>Share a tab or window to see marks here.</p> : null}
          {isLocal && helper ? <AnnotationHelperOffer client={client} state={state} actorId={actorId} helper={helper} capture={capture} /> : null}
          {isLocal ? <AnnotationTabCue client={client} publicationId={state.layer.publication_id} sharerId={state.layer.sharer_id} /> : null}
          {showToolbar || showOwnClear || state.access.can_moderate ? (
            <div
              className="pointer-events-auto min-w-0 max-w-full"
              onKeyDown={(event) => {
                if (event.key === "Escape" && showToolbar) setToolsOpen(false);
              }}
            >
              <ScreenAnnotationToolbar
                brush={brush}
                defaultColor={state.access.default_color}
                enabled={showToolbar}
                canEdit={showToolbar}
                canModerate={state.access.can_moderate}
                busy={busy}
                onBrushChange={setBrush}
                onCommand={(action) => void command(action)}
                onSave={editable && safePreview && saveToWhiteboard ? () => void exportFrame(saveToWhiteboard, true) : undefined}
                onDownload={editable && safePreview && downloadPng ? () => void exportFrame(downloadPng, false) : undefined}
              />
            </div>
          ) : null}
          {feedback ? (
            <p role={feedback.error ? "alert" : "status"} className={annotationControl}>
              {feedback.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
