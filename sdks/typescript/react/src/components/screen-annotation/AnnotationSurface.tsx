import { BakedExportProof, type AnnotationFit } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationPresence, ScreenAnnotationState, ScreenShareCapture, WhiteboardSlice } from "@q9labsai/chalk-client";
import { AnnotationDock, SharerControls, ViewerControls, type Presentation } from "./AnnotationControls";
import { useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AnnotationPerson } from "./AnnotationAccess";
import { ScreenAnnotationLayer } from "./ScreenAnnotationLayer";
import { downloadAnnotationPng } from "./download-png";
import { saveAnnotationToBoard } from "./save-to-board";
import { useAnnotationActions } from "./use-annotation-actions";
import { canDraw, defaultBrush, type AnnotationAuthor, type AnnotationBrush, type ScreenAnnotationActions, type ScreenAnnotationBoard, type ScreenAnnotationOptions, type ScreenAnnotationHelper } from "./model";

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
  /** The share header above the preview: the viewer's drawing controls, and the sharer's title line and buttons. */
  readonly headerHost?: HTMLElement | null;
  readonly titleHost?: HTMLElement | null;
  readonly policyHost?: HTMLElement | null;
};

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
  headerHost,
  titleHost,
  policyHost,
  fit,
  track,
  primary,
  isLocal,
  capture,
  actorId,
  actorName,
  sharerName,
  people,
}: Omit<SurfaceProps, "annotation" | "live" | "grants"> & {
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
  // A window share may be this browser window. Only an excluded call tab can host ink in-tab. The sharer sees marks and moderates; viewers draw.
  const safePreview = !isLocal || capture?.surface === "browser";
  const canExport = connected && !isLocal && canDraw(state, actorId) && safePreview;
  const drawing = primary && toolsOpen && canExport;
  const exportActions = useAnnotationActions({ client, state, actions, videoRef, track, actorId, allowExport: canExport, exportProof, bakedFrame });
  const run = (action: ScreenAnnotationCommand) => void exportActions.command(action);
  const presentation = { client, state, presence, fontUrl };
  return (
    <>
      <InkLayer
        host={safePreview ? canvasHost : null}
        presentation={presentation}
        videoRef={videoRef}
        track={track}
        fit={fit}
        exportProof={exportProof}
        bakedFrame={bakedFrame}
        actor={{ participant_id: actorId, display_name: actorName, color: state.access.default_color }}
        brush={brush}
        drawing={drawing}
        onCommandError={exportActions.onError}
      />
      {primary && connected ? (
        <AnnotationDock isLocal={isLocal} feedback={exportActions.feedback}>
          {isLocal ? (
            <SharerControls titleHost={titleHost} policyHost={policyHost} presentation={presentation} actorId={actorId} people={people} track={track} capture={capture} safePreview={safePreview} helper={helper} run={run} />
          ) : (
            <ViewerControls host={headerHost} client={client} state={state} actorId={actorId} sharerName={sharerName} drawing={drawing} brush={brush} onBrushChange={setBrush} onToolsOpenChange={setToolsOpen} exportActions={exportActions} run={run} />
          )}
        </AnnotationDock>
      ) : null}
    </>
  );
}

function InkLayer({
  host,
  presentation,
  videoRef,
  track,
  fit,
  exportProof,
  bakedFrame,
  actor,
  brush,
  drawing,
  onCommandError,
}: {
  readonly host: HTMLDivElement | null;
  readonly presentation: Presentation;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly track: MediaStreamTrack;
  readonly fit: AnnotationFit;
  readonly exportProof: BakedExportProof;
  readonly bakedFrame: RefObject<HTMLCanvasElement | null>;
  readonly actor: AnnotationAuthor;
  readonly brush: AnnotationBrush;
  readonly drawing: boolean;
  readonly onCommandError: (message: string) => void;
}) {
  if (!host) return null;
  const input = drawing ? { actor, brush, onCommandError } : undefined;
  return createPortal(<ScreenAnnotationLayer {...presentation} videoRef={videoRef} track={track} fit={fit} exportProof={exportProof} bakedFrame={bakedFrame} viewerId={actor.participant_id} input={input} />, host);
}
