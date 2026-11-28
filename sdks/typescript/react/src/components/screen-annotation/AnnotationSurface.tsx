import { BakedExportProof, type AnnotationFit } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationPresence, ScreenAnnotationState, ScreenShareCapture, WhiteboardSlice } from "@q9labsai/chalk-client";
import { useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePhoneCall } from "../../internal/call-width";
import { DrawEntry, SharerNotice, WhoCanDrawMenu, type AnnotationPerson } from "./AnnotationAccess";
import { AnnotationPictureInPicture } from "./AnnotationPictureInPicture";
import { AnnotationTabCue } from "./AnnotationTabCue";
import { AnnotationHelperOffer } from "./AnnotationHelperOffer";
import { AnnotationStyles } from "./AnnotationStyles";
import { ScreenAnnotationLayer } from "./ScreenAnnotationLayer";
import { ScreenAnnotationToolbar } from "./ScreenAnnotationToolbar";
import { downloadAnnotationPng } from "./download-png";
import { saveAnnotationToBoard } from "./save-to-board";
import { useAnnotationActions } from "./use-annotation-actions";
import { canDraw, defaultBrush, type ScreenAnnotationActions, type ScreenAnnotationBoard, type ScreenAnnotationOptions, type ScreenAnnotationHelper } from "./model";

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
  readonly sharerName: string;
  /** Where the sharer's bar above the preview takes the policy pill and the second row. */
  readonly policyHost?: HTMLElement | null;
  readonly noticeHost?: HTMLElement | null;
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
  const { state, connected } = useShareLayer(snapshot, publicationId, props.track, props.live);
  if (!state) return null;
  const activeActions = {
    saveToWhiteboard: actions?.saveToWhiteboard ?? (board?.allowSave ? save : undefined),
    downloadPng: actions?.downloadPng ?? (offerPngDownload ? downloadAnnotationPng : undefined),
  };
  return <ActiveAnnotationSurface key={state.layer.layer_id} {...props} client={client} fontUrl={fontUrl} helper={helper} actions={activeActions} state={state} presence={snapshot.status === "ready" ? snapshot.presence : []} connected={connected} />;
}

function useShareLayer(snapshot: ReturnType<ScreenAnnotationClient["getSnapshot"]>, publicationId: string, track: MediaStreamTrack, shareIsLive: boolean) {
  const [last, setLast] = useState<{ readonly track: MediaStreamTrack; readonly state: ScreenAnnotationState } | null>(null);
  const live = snapshot.status === "ready" && shareIsLive && snapshot.state?.layer.publication_id === publicationId ? snapshot.state : null;
  if (live && live.layer.burned_in && (last?.state !== live || last.track !== track)) {
    setLast({ track: track, state: live });
  } else if (last && !live?.layer.burned_in && snapshot.status !== "connecting") {
    setLast(null);
  }
  // Keep observing the same video through a Sync-only disconnect, without permitting stale interactions.
  const recovering = snapshot.status === "connecting" && shareIsLive && last?.track === track && last.state.layer.publication_id === publicationId;
  const state = live ?? (recovering ? last.state : null);
  return { state, connected: live !== null };
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
  policyHost,
  noticeHost,
  fit,
  track,
  primary,
  isLocal,
  capture,
  actorId,
  actorName,
  sharerName,
  people = noPeople,
}: Omit<SurfaceProps, "annotation" | "live" | "grants"> & {
  readonly client: ScreenAnnotationClient;
  readonly connected: boolean;
  readonly state: ScreenAnnotationState;
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly fontUrl?: string;
  readonly helper?: ScreenAnnotationHelper;
  readonly actions?: ScreenAnnotationActions;
}): React.JSX.Element {
  const phone = usePhoneCall();
  const [brush, setBrush] = useState(defaultBrush);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [helperOpen, setHelperOpen] = useState(false);
  const [helperShowing, setHelperShowing] = useState(false);
  const exportProof = useMemo(() => new BakedExportProof(), [state.layer.layer_id, state.fence, track]);
  const bakedFrame = useRef<HTMLCanvasElement | null>(null);
  // A window share may be this browser window. Only an excluded call tab can host ink in-tab. The sharer sees marks and moderates; viewers draw.
  const safePreview = !isLocal || capture?.surface === "browser";
  const editable = !isLocal && canDraw(state, actorId);
  const drawingOpen = connected && toolsOpen && editable && safePreview;
  const exportActions = useAnnotationActions({ client, state, actions, videoRef, track, actorId, allowExport: connected && editable && safePreview, exportProof, bakedFrame });
  const { feedback, busy, command, saveFrame, downloadFrame } = exportActions;
  const run = (action: ScreenAnnotationCommand) => void command(action);

  const canPopOut = capture?.surface === "browser" || capture?.surface === "window";
  const helperOffered = Boolean(helper?.installUrl) && capture?.surface !== "browser";
  const presentation = { client, state, presence, fontUrl };
  return (
    <>
      {safePreview && canvasHost
        ? createPortal(
            <ScreenAnnotationLayer
              {...presentation}
              videoRef={videoRef}
              track={track}
              fit={fit}
              exportProof={exportProof}
              bakedFrame={bakedFrame}
              viewerId={actorId}
              input={primary && drawingOpen ? { actor: { participant_id: actorId, display_name: actorName, color: state.access.default_color }, brush, onCommandError: exportActions.onError } : undefined}
            />,
            canvasHost,
          )
        : null}
      {primary && connected ? (
        <div data-part="screen-annotation-controls" className="chalk-ann-dock" data-local={isLocal ? "" : undefined}>
          <AnnotationStyles />
          <AnnotationFeedback feedback={feedback} />
          {isLocal && helper ? <AnnotationHelperOffer client={client} state={state} actorId={actorId} helper={helper} capture={capture} open={helperOpen} onOpenChange={setHelperOpen} onShowing={setHelperShowing} /> : null}
          {isLocal ? <AnnotationTabCue client={client} publicationId={state.layer.publication_id} sharerId={state.layer.sharer_id} /> : null}
          {isLocal ? null : drawingOpen ? (
            <div onKeyDown={(event) => event.key === "Escape" && setToolsOpen(false)}>
              <ScreenAnnotationToolbar brush={brush} defaultColor={state.access.default_color} phone={phone} busy={busy} onBrushChange={setBrush} onCommand={run} onSave={saveFrame} onDownload={downloadFrame} onDone={() => setToolsOpen(false)} />
            </div>
          ) : (
            <DrawEntry client={client} state={state} actorId={actorId} sharerName={sharerName} onDraw={() => setToolsOpen(true)} onRequest={() => run({ kind: "request_draw" })} />
          )}
        </div>
      ) : null}
      {isLocal && primary && connected && !phone && policyHost
        ? createPortal(
            <>
              <WhoCanDrawMenu state={state} command={run} />
              {canPopOut ? <AnnotationPictureInPicture {...presentation} viewerId={actorId} track={track} inTab={safePreview} helperAvailable={helperOffered} /> : null}
            </>,
            policyHost,
          )
        : null}
      {isLocal && primary && connected && !phone && noticeHost
        ? createPortal(<SharerNotice client={client} state={state} presence={presence} actorId={actorId} people={people} helperOffered={helperOffered} helperShowing={helperShowing} command={run} onShowMarks={() => setHelperOpen(true)} />, noticeHost)
        : null}
    </>
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
