import { BakedExportProof, type AnnotationFit } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationPresence, ScreenAnnotationState, ScreenShareCapture, WhiteboardSlice } from "@q9labsai/chalk-client";
import { useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
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
import { downloadAnnotationPng } from "./download-png";
import { saveAnnotationToBoard } from "./save-to-board";
import { readSharerLayout } from "./sharer-layout";
import { useAnnotationActions } from "./use-annotation-actions";
import { canDraw, defaultBrush, type AnnotationBrush, type ScreenAnnotationActions, type ScreenAnnotationBoard, type ScreenAnnotationOptions, type ScreenAnnotationHelper } from "./model";

export interface AnnotationPresentationContext {
  readonly actorId: string;
  readonly actorName: string;
  readonly people?: readonly AnnotationPerson[];
  readonly grants?: WhiteboardSlice["access"]["permissions"];
  readonly board?: ScreenAnnotationBoard;
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

export default function AnnotationSurface({ annotation, board, ...props }: SurfaceProps): React.JSX.Element | null {
  const { client, publicationId, actions, fontUrl, helper, offerPngDownload } = annotation;
  const boardClient = board?.client;
  const boardTransport = board?.transport;
  const save = useMemo(() => (boardClient && boardTransport ? saveAnnotationToBoard(boardClient, boardTransport, fontUrl) : undefined), [boardClient, boardTransport, fontUrl]);
  const snapshot = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  );
  const [last, setLast] = useState<{ readonly track: MediaStreamTrack; readonly state: ScreenAnnotationState } | null>(null);
  const live = snapshot.status === "ready" && props.live && snapshot.state?.layer.publication_id === publicationId ? snapshot.state : null;
  if (live && live.layer.burned_in && (last?.state !== live || last.track !== props.track)) {
    setLast({ track: props.track, state: live });
  } else if (last && !live?.layer.burned_in && snapshot.status !== "connecting") {
    setLast(null);
  }
  // Keep observing the same video through a Sync-only disconnect, without permitting stale interactions.
  const recovering = snapshot.status === "connecting" && props.live && last?.track === props.track && last.state.layer.publication_id === publicationId;
  const state = live ?? (recovering ? last.state : null);
  if (!state) return null;
  const activeActions = {
    saveToWhiteboard: actions?.saveToWhiteboard ?? (board?.allowSave ? save : undefined),
    downloadPng: actions?.downloadPng ?? (offerPngDownload ? downloadAnnotationPng : undefined),
  };
  return <ActiveAnnotationSurface key={state.layer.layer_id} {...props} client={client} fontUrl={fontUrl} helper={helper} actions={activeActions} state={state} presence={snapshot.status === "ready" ? snapshot.presence : []} connected={Boolean(live)} />;
}

function ActiveAnnotationSurface({
  client,
  state,
  connected,
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
  readonly connected: boolean;
  readonly state: ScreenAnnotationState;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly fontUrl?: string;
  readonly helper?: ScreenAnnotationHelper;
  readonly actions?: ScreenAnnotationActions;
}): React.JSX.Element {
  const [brush, setBrush] = useState(defaultBrush);
  const [toolsOpen, setToolsOpen] = useState(false);
  const exportProof = useMemo(() => new BakedExportProof(), [state.layer.layer_id, state.fence, track]);
  const bakedFrame = useRef<HTMLCanvasElement | null>(null);
  const editable = canDraw(state, actorId);
  // A window share may be this browser window. Only an excluded call tab can host ink in-tab.
  const safePreview = !isLocal || capture?.surface === "browser";
  const showToolbar = connected && toolsOpen && editable && safePreview;
  const exportActions = useAnnotationActions({ client, state, actions, videoRef, track, actorId, allowExport: connected && editable && safePreview, exportProof, bakedFrame });

  const annotationProps = { client, state, presence, fontUrl };
  const annotate = editable && safePreview ? <AnnotateButton expanded={showToolbar} hints={isLocal} onClick={() => setToolsOpen(!toolsOpen)} /> : null;
  return (
    <>
      {safePreview && canvasHost
        ? createPortal(
            <ScreenAnnotationLayer
              {...annotationProps}
              videoRef={videoRef}
              track={track}
              fit={fit}
              exportProof={exportProof}
              bakedFrame={bakedFrame}
              input={primary && showToolbar ? { actor: { participant_id: actorId, display_name: actorName, color: state.access.default_color }, brush, onCommandError: exportActions.onError } : undefined}
            />,
            canvasHost,
          )
        : null}
      {primary && connected ? (
        <AnnotationDock
          presentation={annotationProps}
          actorId={actorId}
          people={people}
          grants={grants}
          track={track}
          isLocal={isLocal}
          safePreview={safePreview}
          helper={helper}
          capture={capture}
          annotate={annotate}
          toolbar={{ brush, showToolbar, onBrush: setBrush, close: () => setToolsOpen(false) }}
          exportActions={exportActions}
        />
      ) : null}
    </>
  );
}

function AnnotationDock({
  presentation,
  actorId,
  people,
  grants,
  track,
  isLocal,
  safePreview,
  helper,
  capture,
  annotate,
  toolbar,
  exportActions,
}: {
  readonly presentation: Pick<React.ComponentProps<typeof ScreenAnnotationLayer>, "client" | "state" | "presence" | "fontUrl">;
  readonly actorId: string;
  readonly people: readonly AnnotationPerson[];
  readonly grants?: AnnotationPresentationContext["grants"];
  readonly track: MediaStreamTrack;
  readonly isLocal: boolean;
  readonly safePreview: boolean;
  readonly helper?: ScreenAnnotationHelper;
  readonly capture?: ScreenShareCapture;
  readonly annotate: React.ReactNode;
  readonly toolbar: Pick<React.ComponentProps<typeof AnnotationTools>, "brush" | "showToolbar" | "onBrush" | "close">;
  readonly exportActions: ReturnType<typeof useAnnotationActions>;
}) {
  const [layout, setLayout] = useState(readSharerLayout);
  const dockRef = useRef<HTMLDivElement>(null);
  const { client, state } = presentation;
  const { feedback, busy, command, saveFrame, downloadFrame } = exportActions;
  const canPopOut = capture?.surface === "browser" || capture?.surface === "window";
  const showOwnClear = state.marks.some((mark) => mark.author.participant_id === actorId);
  const access = { client, state, actorId, people, grants, command: (action: ScreenAnnotationCommand) => void command(action) };
  return (
    <div ref={dockRef} data-part="screen-annotation-controls" className="chalk-ann-dock" data-local={isLocal ? "" : undefined} data-stack={isLocal && layout.edge === "bottom" ? "top" : undefined}>
      <AnnotationStyles />
      {isLocal && !canPopOut ? <p className="chalk-ann-chip">Share a tab or window for a marks preview.</p> : null}
      <AnnotationFeedback feedback={feedback} />
      {isLocal && helper ? <AnnotationHelperOffer client={client} state={state} actorId={actorId} helper={helper} capture={capture} /> : null}
      {isLocal ? <AnnotationTabCue client={client} publicationId={state.layer.publication_id} sharerId={state.layer.sharer_id} /> : null}
      {toolbar.showToolbar || showOwnClear || state.access.can_moderate ? <AnnotationTools {...toolbar} state={state} busy={busy} onCommand={command} onSave={saveFrame} onDownload={downloadFrame} /> : null}
      {isLocal ? (
        <AnnotationSharerControl dockRef={dockRef} layout={layout} onLayout={setLayout}>
          {annotate}
          <AnnotationAccess {...access} side={layout.edge === "bottom" ? "top" : "bottom"} hints />
          {canPopOut ? <AnnotationPictureInPicture {...presentation} track={track} inTab={safePreview} hints /> : null}
        </AnnotationSharerControl>
      ) : (
        <div className="chalk-ann-bar">
          {annotate}
          {annotate ? <span aria-hidden="true" className="chalk-ann-sep" /> : null}
          <AnnotationAccess {...access} />
        </div>
      )}
    </div>
  );
}

function AnnotationFeedback({ feedback }: { readonly feedback: ReturnType<typeof useAnnotationActions>["feedback"] }) {
  if (!feedback) return null;
  return (
    <p role={feedback.error ? "alert" : "status"} className="chalk-ann-chip" data-tone={feedback.error ? "error" : undefined}>
      {feedback.message}
    </p>
  );
}

function AnnotationTools({
  brush,
  state,
  showToolbar,
  busy,
  onBrush,
  onCommand,
  close,
  onSave,
  onDownload,
}: {
  readonly brush: AnnotationBrush;
  readonly state: ScreenAnnotationState;
  readonly showToolbar: boolean;
  readonly busy: boolean;
  readonly onBrush: (brush: AnnotationBrush) => void;
  readonly onCommand: (command: ScreenAnnotationCommand) => void;
  readonly close: () => void;
  readonly onSave?: () => void;
  readonly onDownload?: () => void;
}) {
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape" && showToolbar) close();
      }}
    >
      <ScreenAnnotationToolbar brush={brush} defaultColor={state.access.default_color} enabled={showToolbar} canEdit={showToolbar} canModerate={state.access.can_moderate} busy={busy} onBrushChange={onBrush} onCommand={(action) => void onCommand(action)} onSave={onSave} onDownload={onDownload} />
    </div>
  );
}

function AnnotateButton({ expanded, hints, onClick }: { readonly expanded: boolean; readonly hints: boolean; readonly onClick: () => void }) {
  const annotateLabel = expanded ? "Hide tools" : "Annotate";
  const button = (
    <button type="button" className="chalk-ann-btn" data-tone={expanded ? undefined : "primary"} aria-expanded={expanded} onClick={onClick}>
      <StageIcon name="pen" size={15} />
      <span className="chalk-ann-label">{annotateLabel}</span>
    </button>
  );
  return hints ? <ChalkTooltip trigger={button}>{annotateLabel}</ChalkTooltip> : button;
}
