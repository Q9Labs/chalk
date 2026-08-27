import React, { useEffect, useRef, type KeyboardEvent } from "react";
import { IconButton } from "@q9labsai/chalk-ui";

import { cn } from "../../utils/cn";
import { Cancel01Icon } from "../../utils/icons";
import { SpaceInfoContent } from "./SpaceInfoContent";
import type { SpaceInfoDialogProps } from "./SpaceInfoDialog";

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const STATE_PILL_CLASS = "inline-flex h-6 items-center gap-1.5 rounded-full bg-[var(--chalk-app-control-group)] px-2.5 text-xs font-semibold";

/**
 * Classic Space details: the Space name is the title, the facts are one flat list underneath.
 * Focus moves into the panel on open, Tab cycles inside it, Escape closes, and focus returns
 * to the opener on close.
 */
export const ClassicSpaceInfoDialog = React.memo<SpaceInfoDialogProps>(({ isOpen, onClose, spaceName, spaceDescription, isRecording = false, isTranscribing = false, duration, className, ...contentProps }) => {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
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
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div data-chalk-skin className="fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_srgb,var(--chalk-app-canvas)_88%,transparent)] p-4 backdrop-blur-[1px]" onMouseDown={onClose}>
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Space details"
        tabIndex={-1}
        className={cn("chalk-textured-surface max-h-[calc(100dvh-2rem)] w-full max-w-[560px] overflow-y-auto rounded-[14px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)] outline-none", className)}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--chalk-app-line)] px-6 pb-4 pt-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h2 className="truncate text-lg font-semibold leading-6 tracking-[-0.01em]">{spaceName}</h2>
              {isRecording ? (
                <span className={cn(STATE_PILL_CLASS, "text-[var(--chalk-app-danger)]")}>
                  <span className="size-1.5 rounded-full bg-[var(--chalk-app-danger)]" aria-hidden="true" />
                  Recording
                </span>
              ) : null}
              {isTranscribing ? <span className={cn(STATE_PILL_CLASS, "text-[var(--chalk-app-text-muted)]")}>Transcribing</span> : null}
            </div>
            {spaceDescription ? <p className="mt-1 text-sm leading-5 text-[var(--chalk-app-text-muted)]">{spaceDescription}</p> : null}
          </div>
          <IconButton
            icon={<Cancel01Icon className="h-5 w-5" />}
            size="sm"
            variant="ghost"
            onClick={onClose}
            aria-label="Close space details"
            className="-mr-2 -mt-1 shrink-0 rounded-full text-[var(--chalk-app-text-muted)] hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)]"
          />
        </header>
        <SpaceInfoContent {...contentProps} duration={duration} />
      </section>
    </div>
  );
});

ClassicSpaceInfoDialog.displayName = "SpaceInfoDialog";
