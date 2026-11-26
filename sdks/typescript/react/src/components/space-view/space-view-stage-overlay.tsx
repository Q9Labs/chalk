import type { ChatUploadFile, Reaction } from "@q9labsai/chalk-client";
import { DEFAULT_QUICK_REACTIONS } from "@q9labsai/chalk-ui/reactions";
import type React from "react";
import type { RefObject } from "react";
import { ReactionPicker } from "../composite/ReactionPicker";
import { ReactionsOverlay } from "../composite/ReactionsOverlay";

export interface SpaceViewStageOverlayOptions {
  readonly presentInputRef: RefObject<HTMLInputElement | null>;
  readonly dropActive: boolean;
  readonly dropTarget: string | null;
  readonly presentOpen: boolean;
  readonly presentingAvailable: boolean;
  readonly presentBusy: boolean;
  readonly choosePresentFiles: () => Promise<void>;
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

function renderFilePresentingOverlay({ presentInputRef, dropActive, dropTarget, presentOpen, presentingAvailable, presentBusy, choosePresentFiles, presentChosenFiles }: SpaceViewStageOverlayOptions): React.JSX.Element {
  return (
    <>
      <input
        ref={presentInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void presentChosenFiles(files);
        }}
      />
      {dropActive && dropTarget ? (
        <div className="pointer-events-none absolute inset-0 z-50 grid place-items-center rounded-[inherit] bg-[var(--chalk-overlay-scrim-soft)] p-6">
          <div className="rounded-3xl border-2 border-dashed border-[var(--chalk-overlay-line-strong)] bg-[var(--chalk-overlay-strong)] px-8 py-6 text-center text-[var(--chalk-on-overlay)] shadow-xl">
            <div className="text-lg font-semibold">{dropTarget === "chat" ? "Drop files to send" : "Drop a file to present"}</div>
            <div className="mt-1 text-sm opacity-75">{dropTarget === "chat" ? "Up to 5 files, 25 MB each" : "PDF or image, up to 25 MB"}</div>
          </div>
        </div>
      ) : null}
      {presentOpen && presentingAvailable ? (
        <div className="absolute bottom-24 left-1/2 z-50 w-72 -translate-x-1/2 rounded-2xl bg-[var(--chalk-overlay-strong)] p-3 text-[var(--chalk-on-overlay)] shadow-xl outline outline-1 outline-[var(--chalk-overlay-hairline)] backdrop-blur" role="dialog" aria-label="Present a file or link">
          <div className="px-2 pb-2 text-sm font-medium">Present a file or link</div>
          <button type="button" className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--chalk-overlay-hover-fill)] px-4 py-3 text-sm font-medium hover:bg-[var(--chalk-overlay-active-fill)] disabled:opacity-50" disabled={presentBusy} onClick={() => void choosePresentFiles()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            {presentBusy ? "Preparing…" : "Choose a file"}
          </button>
          <div className="px-2 pt-2.5 text-center text-xs opacity-70">
            <div>or drop a file anywhere</div>
            <div className="pt-0.5 opacity-80">PDFs and images up to 25 MB</div>
          </div>
        </div>
      ) : null}
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
