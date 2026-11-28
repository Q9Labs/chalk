import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationPresence, ScreenAnnotationState, ScreenShareCapture } from "@q9labsai/chalk-client";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { usePhoneCall } from "../../internal/call-width";
import { DrawEntry, SharerTitle, WhoCanDrawMenu, type AnnotationPerson } from "./AnnotationAccess";
import { AnnotationHelperOffer } from "./AnnotationHelperOffer";
import { AnnotationPictureInPicture } from "./AnnotationPictureInPicture";
import { AnnotationStyles } from "./AnnotationStyles";
import { AnnotationTabCue } from "./AnnotationTabCue";
import { ScreenAnnotationToolbar } from "./ScreenAnnotationToolbar";
import type { AnnotationBrush, ScreenAnnotationHelper } from "./model";
import type { useAnnotationActions } from "./use-annotation-actions";

const noPeople: readonly AnnotationPerson[] = [];

export type Presentation = { readonly client: ScreenAnnotationClient; readonly state: ScreenAnnotationState; readonly presence: readonly ScreenAnnotationPresence[]; readonly fontUrl?: string };

export function AnnotationDock({ isLocal, feedback, children }: { readonly isLocal: boolean; readonly feedback: ReturnType<typeof useAnnotationActions>["feedback"]; readonly children: React.ReactNode }) {
  return (
    <div data-part="screen-annotation-controls" className="chalk-ann-dock" data-local={isLocal ? "" : undefined}>
      <AnnotationStyles />
      <AnnotationFeedback feedback={feedback} />
      {children}
    </div>
  );
}

export function ViewerControls({
  host,
  client,
  state,
  actorId,
  sharerName,
  drawing,
  brush,
  onBrushChange,
  onToolsOpenChange,
  exportActions,
  run,
}: {
  readonly host?: HTMLElement | null;
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly actorId: string;
  readonly sharerName: string;
  readonly drawing: boolean;
  readonly brush: AnnotationBrush;
  readonly onBrushChange: (brush: AnnotationBrush) => void;
  readonly onToolsOpenChange: (open: boolean) => void;
  readonly exportActions: ReturnType<typeof useAnnotationActions>;
  readonly run: (action: ScreenAnnotationCommand) => void;
}) {
  const phone = usePhoneCall();
  if (!host) return null;
  const { busy, saveFrame, downloadFrame } = exportActions;
  return createPortal(
    <div className="contents" onKeyDown={(event) => event.key === "Escape" && onToolsOpenChange(false)}>
      {drawing ? (
        <ScreenAnnotationToolbar brush={brush} defaultColor={state.access.default_color} phone={phone} busy={busy} onBrushChange={onBrushChange} onCommand={run} onSave={saveFrame} onDownload={downloadFrame} onDone={() => onToolsOpenChange(false)} />
      ) : (
        <DrawEntry client={client} state={state} actorId={actorId} sharerName={sharerName} onDraw={() => onToolsOpenChange(true)} onRequest={() => run({ kind: "request_draw" })} />
      )}
    </div>,
    host,
  );
}

export function SharerControls({
  titleHost,
  policyHost,
  presentation,
  actorId,
  people = noPeople,
  track,
  capture,
  safePreview,
  helper,
  run,
}: {
  readonly titleHost?: HTMLElement | null;
  readonly policyHost?: HTMLElement | null;
  readonly presentation: Presentation;
  readonly actorId: string;
  readonly people?: readonly AnnotationPerson[];
  readonly track: MediaStreamTrack;
  readonly capture?: ScreenShareCapture;
  readonly safePreview: boolean;
  readonly helper?: ScreenAnnotationHelper;
  readonly run: (action: ScreenAnnotationCommand) => void;
}) {
  const phone = usePhoneCall();
  const [helperOpen, setHelperOpen] = useState(false);
  const [helperShowing, setHelperShowing] = useState(false);
  const { client, state, presence } = presentation;
  const canPopOut = capture?.surface === "browser" || capture?.surface === "window";
  const helperOffered = Boolean(helper?.installUrl) && capture?.surface !== "browser";
  return (
    <>
      {helper ? <AnnotationHelperOffer client={client} state={state} actorId={actorId} helper={helper} capture={capture} open={helperOpen} onOpenChange={setHelperOpen} onShowing={setHelperShowing} /> : null}
      <AnnotationTabCue client={client} publicationId={state.layer.publication_id} sharerId={state.layer.sharer_id} />
      {titleHost ? createPortal(<SharerTitle client={client} state={state} presence={presence} actorId={actorId} people={people} helperShowing={helperShowing} command={run} />, titleHost) : null}
      {policyHost
        ? createPortal(
            <>
              <WhoCanDrawMenu state={state} command={run} />
              {canPopOut && !phone ? <AnnotationPictureInPicture {...presentation} viewerId={actorId} track={track} inTab={safePreview} helperAvailable={helperOffered} /> : null}
              {helperOffered && !helperShowing && !phone ? (
                <button type="button" className="chalk-ann-pill" onClick={() => setHelperOpen(true)}>
                  <HugeiconsIcon icon={PencilEdit02Icon} size={16} aria-hidden="true" />
                  Show on my screen
                </button>
              ) : null}
            </>,
            policyHost,
          )
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
