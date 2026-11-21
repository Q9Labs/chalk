import { captureAnnotationVideoFrame, type AnnotationFit } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationPresence, ScreenAnnotationState, ScreenAnnotationTarget, ScreenShareCapture, WhiteboardSlice } from "@q9labsai/chalk-client";
import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChalkTooltip } from "../chalk-ui";
import { StageIcon } from "../stage/StageIcon";
import { AnnotationAccess, type AnnotationPerson } from "./AnnotationAccess";
import { AnnotationPictureInPicture } from "./AnnotationPictureInPicture";
import { AnnotationTabCue } from "./AnnotationTabCue";
import { AnnotationHelperOffer } from "./AnnotationHelperOffer";
import { AnnotationSharerControl } from "./AnnotationSharerControl";
import { AnnotationStyles } from "./AnnotationStyles";
import { ScreenAnnotationLayer } from "./ScreenAnnotationLayer";
import { ScreenAnnotationToolbar } from "./ScreenAnnotationToolbar";
import { readSharerLayout } from "./sharer-layout";
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
  const [layout, setLayout] = useState(readSharerLayout);
  const dockRef = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const boardRetry = useRef<{ frame: ScreenAnnotationFrame; target: ScreenAnnotationTarget; action: NonNullable<ScreenAnnotationActions["saveToWhiteboard"]> } | null>(null);
  const target = targetOf(state);
  const { saveToWhiteboard, downloadPng } = actions ?? {};
  const editable = canDraw(state, actorId);
  // A window share may be this browser window. Only an excluded call tab can host ink in-tab.
  const safePreview = !isLocal || capture?.surface === "browser";
  const canPopOut = capture?.surface === "browser" || capture?.surface === "window";
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
  const annotateLabel = showToolbar ? "Hide tools" : "Annotate";
  const annotateButton =
    editable && safePreview ? (
      <button type="button" className="chalk-ann-btn" data-tone={showToolbar ? undefined : "primary"} aria-expanded={showToolbar} onClick={() => setToolsOpen(!toolsOpen)}>
        <StageIcon name="pen" size={15} />
        <span className="chalk-ann-label">{annotateLabel}</span>
      </button>
    ) : null;
  const annotate = annotateButton && isLocal ? <ChalkTooltip trigger={annotateButton}>{annotateLabel}</ChalkTooltip> : annotateButton;
  return (
    <>
      {safePreview && canvasHost
        ? createPortal(
            <ScreenAnnotationLayer {...annotationProps} videoRef={videoRef} track={track} fit={fit} input={primary && showToolbar ? { actor: { participant_id: actorId, display_name: actorName, color: state.access.default_color }, brush, onCommandError: onError } : undefined} />,
            canvasHost,
          )
        : null}
      {primary ? (
        <div ref={dockRef} data-part="screen-annotation-controls" className="chalk-ann-dock" data-local={isLocal ? "" : undefined} data-stack={isLocal && layout.edge === "bottom" ? "top" : undefined}>
          <AnnotationStyles />
          {isLocal && !canPopOut ? <p className="chalk-ann-chip">Share a tab or window for a marks preview.</p> : null}
          {feedback ? (
            <p role={feedback.error ? "alert" : "status"} className="chalk-ann-chip" data-tone={feedback.error ? "error" : undefined}>
              {feedback.message}
            </p>
          ) : null}
          {isLocal && helper ? <AnnotationHelperOffer client={client} state={state} actorId={actorId} helper={helper} capture={capture} /> : null}
          {isLocal ? <AnnotationTabCue client={client} publicationId={state.layer.publication_id} sharerId={state.layer.sharer_id} /> : null}
          {showToolbar || showOwnClear || state.access.can_moderate ? (
            <div
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
          {isLocal ? (
            <AnnotationSharerControl dockRef={dockRef} layout={layout} onLayout={setLayout}>
              {annotate}
              <AnnotationAccess client={client} state={state} actorId={actorId} people={people} grants={grants} command={(action) => void command(action)} side={layout.edge === "bottom" ? "top" : "bottom"} hints />
              {canPopOut ? <AnnotationPictureInPicture {...annotationProps} track={track} inTab={safePreview} hints /> : null}
            </AnnotationSharerControl>
          ) : (
            <div className="chalk-ann-bar">
              {annotate}
              {annotate ? <span aria-hidden="true" className="chalk-ann-sep" /> : null}
              <AnnotationAccess client={client} state={state} actorId={actorId} people={people} grants={grants} command={(action) => void command(action)} />
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
