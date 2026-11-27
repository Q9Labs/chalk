import { CHALK_CHAT_ATTACHMENT_LIMITS, type ChatUploadFile, type Reaction } from "@q9labsai/chalk-client";
import { DEFAULT_QUICK_REACTIONS } from "@q9labsai/chalk-ui/reactions";
import type React from "react";
import type { RefObject } from "react";
import { ReactionPicker } from "../composite/ReactionPicker";
import { ReactionsOverlay } from "../composite/ReactionsOverlay";
import { PRESENTABLE_ACCEPT, presentableFilesHint, type PresentingFileFailure } from "../stage/presenting-files";
import type { DropZone, StageUpload } from "./use-file-presenting";

export interface SpaceViewStageOverlayOptions {
  readonly presentInputRef: RefObject<HTMLInputElement | null>;
  readonly dropActive: boolean;
  readonly dropZones: readonly DropZone[];
  readonly dropZone: DropZone | null;
  readonly stageUpload: StageUpload | null;
  readonly dismissStageUpload: () => void;
  readonly retryStageUpload: () => void;
  readonly sendStageUploadToChat: () => void;
  readonly presentChosenFiles: (files: readonly ChatUploadFile[]) => Promise<void>;
  readonly reactionsEnabled: boolean;
  readonly canSendReaction: boolean;
  readonly live: boolean;
  readonly handRaiseEnabled: boolean;
  readonly canRaiseHand: boolean;
  readonly isHandRaised: boolean;
  readonly onToggleHandRaise: () => void;
  readonly reactionPickerOpen: boolean;
  readonly onReactionPickerClose: () => void;
  readonly onSelectReaction: (reaction: Reaction) => void;
}

const failureCopy: Record<PresentingFileFailure["reason"], string> = {
  failed: "It could not be uploaded. Nobody else saw it.",
  too_big: "It is over 25 MB.",
  empty: "It is empty.",
  unsupported: "This type of file can't go on the Stage.",
};

function DropTarget({ zone, active, icon, title, hint }: { readonly zone: DropZone; readonly active: boolean; readonly icon: string; readonly title: string; readonly hint: string }): React.JSX.Element {
  return (
    <div
      data-drop-zone={zone}
      data-hot={active || undefined}
      className="flex h-64 max-w-sm flex-1 flex-col items-center justify-center gap-1.5 rounded-3xl border-2 border-dashed border-[var(--chalk-overlay-line-strong)] bg-[var(--chalk-overlay-strong)] px-6 text-center text-[var(--chalk-on-overlay)] shadow-xl data-[hot]:border-[var(--chalk-on-overlay)]"
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={icon} />
      </svg>
      <div className="text-lg font-semibold">{title}</div>
      <div className="text-sm opacity-75">{hint}</div>
    </div>
  );
}

const UPLOAD_ICON = "M12 16V4M7 9l5-5 5 5M4 20h16";
const CHAT_ICON = "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z";

function StageUploadCard({ upload, onRetry, onSendToChat, onClose }: { readonly upload: StageUpload; readonly onRetry: () => void; readonly onSendToChat: () => void; readonly onClose: () => void }): React.JSX.Element {
  const failed = upload.kind === "failed";
  const percent = !failed && upload.progress !== null ? Math.round(upload.progress * 100) : null;
  return (
    <div className="absolute inset-0 z-40 grid place-items-center rounded-[inherit] bg-[var(--chalk-app-tile-base)] p-6 text-[var(--chalk-on-overlay)]">
      <div role={failed ? "alert" : "status"} className="flex w-80 max-w-full flex-col items-center gap-3 rounded-2xl bg-[var(--chalk-overlay-strong)] p-5 text-center shadow-xl">
        <span className="grid h-9 w-8 place-items-center rounded-md bg-[var(--chalk-file-pdf)] text-(length:--type-micro) font-bold">{failed ? "!" : "PDF"}</span>
        <div className="max-w-full truncate text-sm font-semibold">{failed ? `Couldn't present ${upload.fileName}` : `Uploading ${upload.fileName}`}</div>
        {failed ? (
          <>
            <div className="text-sm opacity-75">{failureCopy[upload.reason]}</div>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" className="rounded-full bg-[var(--chalk-on-overlay)] px-4 py-2 text-sm font-medium text-[var(--chalk-overlay-inverse)] hover:opacity-85" autoFocus onClick={onRetry}>
                {upload.reason === "failed" ? "Try again" : "Choose another file"}
              </button>
              {upload.file ? (
                <button type="button" className="rounded-full bg-[var(--chalk-overlay-hover-fill)] px-4 py-2 text-sm font-medium hover:bg-[var(--chalk-overlay-active-fill)]" onClick={onSendToChat}>
                  Send in chat instead
                </button>
              ) : null}
              <button type="button" className="rounded-full px-4 py-2 text-sm font-medium opacity-80 hover:opacity-100" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm opacity-75">Everyone sees page 1 as soon as it's ready</div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--chalk-overlay-track)]" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
              <div className={percent === null ? "h-full w-1/3 animate-pulse rounded-full bg-[var(--chalk-overlay-track-fill)]" : "h-full rounded-full bg-[var(--chalk-overlay-track-fill)]"} style={percent === null ? undefined : { width: `${percent}%` }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function renderFilePresentingOverlay({ presentInputRef, dropActive, dropZones, dropZone, stageUpload, dismissStageUpload, retryStageUpload, sendStageUploadToChat, presentChosenFiles }: SpaceViewStageOverlayOptions): React.JSX.Element {
  return (
    <>
      <input
        ref={presentInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept={PRESENTABLE_ACCEPT}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void presentChosenFiles(files);
        }}
      />
      {dropActive && dropZones.length ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center gap-4 rounded-[inherit] bg-[var(--chalk-overlay-scrim-soft)] p-10">
          {dropZones.map((zone) =>
            zone === "present" ? (
              <DropTarget key={zone} zone={zone} active={dropZone === zone || dropZones.length === 1} icon={UPLOAD_ICON} title="Drop to present" hint={`Everyone sees it on the Stage. ${presentableFilesHint()}`} />
            ) : (
              <DropTarget key={zone} zone={zone} active={dropZone === zone || dropZones.length === 1} icon={CHAT_ICON} title="Send in chat" hint={`Up to ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files, ${Math.round(CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength / (1024 * 1024))} MB each`} />
            ),
          )}
        </div>
      ) : null}
      {stageUpload ? <StageUploadCard upload={stageUpload} onRetry={retryStageUpload} onSendToChat={sendStageUploadToChat} onClose={dismissStageUpload} /> : null}
    </>
  );
}

function renderReactions({ reactionsEnabled, canSendReaction, live, handRaiseEnabled, canRaiseHand, isHandRaised, onToggleHandRaise, reactionPickerOpen, onReactionPickerClose, onSelectReaction }: SpaceViewStageOverlayOptions): React.JSX.Element {
  return (
    <>
      {reactionsEnabled ? <ReactionsOverlay /> : null}
      {/* The tray wrapper must not be transformed: a transformed ancestor shrinks the tray's fixed backdrop to an empty box. Its z-index stays under the notices (45) so they remain clickable over the backdrop. */}
      {reactionsEnabled && canSendReaction && live ? (
        <div className="absolute bottom-24 left-1/2 z-44">
          <ReactionPicker
            isHandRaised={isHandRaised}
            onToggleHandRaise={handRaiseEnabled && canRaiseHand ? onToggleHandRaise : undefined}
            isOpen={reactionPickerOpen}
            onClose={onReactionPickerClose}
            allowedReactions={[...DEFAULT_QUICK_REACTIONS]}
            onSelect={(reaction) => onSelectReaction(reaction as Reaction)}
            size="compact"
          />
        </div>
      ) : null}
    </>
  );
}

export function renderSpaceViewStageOverlay(options: SpaceViewStageOverlayOptions): React.JSX.Element {
  return (
    <>
      {renderFilePresentingOverlay(options)}
      {renderReactions(options)}
    </>
  );
}
