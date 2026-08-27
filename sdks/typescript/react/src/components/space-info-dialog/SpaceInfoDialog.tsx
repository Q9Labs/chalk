import React, { useEffect, useId, useRef, type KeyboardEvent } from "react";

import { cn } from "../../utils/cn";
import { Cancel01Icon } from "../../utils/icons";
import { ChalkBackdrop, ChalkBadge, ChalkDialogPanel, ChalkIconButton } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicSpaceInfoDialog } from "./ClassicSpaceInfoDialog";
import { SpaceInfoContent } from "./SpaceInfoContent";

export interface SpaceInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spaceName: string;
  spaceDescription?: string;
  spaceId?: string;
  inviteLink?: string;
  onCopyLink?: () => void;
  diagnosticReference?: string;
  onCopyDiagnosticReference?: (reference: string) => void;
  onSendFeedback?: (context: Readonly<{ diagnosticReference: string }>) => void;
  isRecording?: boolean;
  isTranscribing?: boolean;
  duration?: number;
  stats?: {
    latency?: number;
    packetLoss?: number;
    bitrate?: string;
    resolution?: string;
    region?: string;
    version?: string;
  };
  className?: string;
}

const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
};

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal Space details. Focus moves into the panel on open, Tab cycles inside it, Escape closes,
 * and focus returns to the opener when the dialog unmounts.
 */
const ChalkSpaceInfoDialog = React.memo<SpaceInfoDialogProps>(({ isOpen, onClose, spaceName, isRecording = false, isTranscribing = false, duration = 0, className, ...contentProps }) => {
  const skin = useSkin();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div data-chalk-skin={skin} className="fixed inset-0 z-[70]" onMouseDown={onClose}>
      <ChalkBackdrop className="z-0 !bg-[color-mix(in_srgb,var(--chalk-app-canvas)_88%,transparent)] !backdrop-blur-[1px]" />
      <div className="relative z-10 grid h-full place-items-center p-4 sm:p-6">
        <ChalkDialogPanel
          ref={panelRef}
          tabIndex={-1}
          className={cn(
            "chalk-textured-surface flex max-h-[calc(100dvh-2rem)] w-full max-w-[600px] flex-col overflow-hidden !rounded-[16px] !border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)] !p-0 shadow-[var(--chalk-app-shadow-sm)] outline-none focus-visible:outline-none",
            className,
          )}
          aria-modal="true"
          aria-labelledby={titleId}
          onKeyDown={handleKeyDown}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--chalk-app-line)] px-6 pt-5 pb-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[22px] font-semibold leading-[1.2] tracking-[-0.02em]">
                Space details
              </h2>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--chalk-app-text-muted)]">
                <span className="truncate font-medium text-[var(--chalk-app-text)]">{spaceName}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[13px] tabular-nums">{formatDuration(duration)}</span>
                {isRecording ? (
                  <ChalkBadge tone="danger" className="!min-h-5 !rounded-full !px-2 !py-0 !text-[11px] !text-[var(--chalk-app-danger)]">
                    Recording
                  </ChalkBadge>
                ) : null}
                {isTranscribing ? (
                  <ChalkBadge tone="accent" className="!min-h-5 !rounded-full !px-2 !py-0 !text-[11px] !text-[var(--chalk-app-control-active-text)]">
                    Transcribing
                  </ChalkBadge>
                ) : null}
              </div>
            </div>
            <ChalkIconButton type="button" onClick={onClose} size="md" className="-mt-1 -mr-2 !rounded-[10px] text-[var(--chalk-app-text-muted)] transition-colors hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)]" aria-label="Close space details">
              <Cancel01Icon size={20} />
            </ChalkIconButton>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <SpaceInfoContent {...contentProps} />
          </div>
        </ChalkDialogPanel>
      </div>
    </div>
  );
});

ChalkSpaceInfoDialog.displayName = "ChalkSpaceInfoDialog";

export const SpaceInfoDialog = React.memo<SpaceInfoDialogProps>((props) => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicSpaceInfoDialog {...props} /> : <ChalkSpaceInfoDialog {...props} />;
});

SpaceInfoDialog.displayName = "SpaceInfoDialog";
