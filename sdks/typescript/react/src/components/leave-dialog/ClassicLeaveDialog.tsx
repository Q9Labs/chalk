import React, { useEffect, useRef, useState } from "react";
import { CallEnd01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { resolvePortalThemeFromDocument } from "../../utils/theme";
import { getThemeMode } from "../theme";
import { useSkin } from "../skin-context";
import type { LeaveDialogProps } from "./LeaveDialog";

export const ClassicLeaveDialog = React.memo<LeaveDialogProps>(({ isOpen, onClose, onConfirm, onEndEpisode, canEndEpisode = true, leavePending = false, leaveError, endEpisodePending = false, endEpisodeError, palette, texture = "none", className }: LeaveDialogProps) => {
  const skin = useSkin();
  const prefersReducedMotion = usePrefersReducedMotion();
  const portalTheme = resolvePortalThemeFromDocument();
  const modalRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [confirmingEndEpisode, setConfirmingEndEpisode] = useState(false);
  const canEndEpisodeAction = Boolean(onEndEpisode && canEndEpisode);
  const activeError = confirmingEndEpisode ? endEpisodeError : leaveError;
  const isPending = leavePending || endEpisodePending;

  useEffect(() => {
    if (!isOpen) setConfirmingEndEpisode(false);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) initialFocusRef.current?.focus();
  }, [isOpen, confirmingEndEpisode]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  if (!isOpen) return null;
  const resolvedTheme = palette ? getThemeMode(palette) : portalTheme;

  return (
    <div
      data-chalk
      data-chalk-skin={skin}
      data-chalk-theme={resolvedTheme}
      data-chalk-palette={palette}
      data-chalk-texture={texture}
      className={cn("chalk-root fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]", !prefersReducedMotion && "animate-in fade-in duration-200", className)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-modal-title"
      aria-describedby="leave-modal-description"
      tabIndex={-1}
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className={cn(
          "chalk-textured-surface relative w-full max-w-[420px] overflow-hidden rounded-[12px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)]",
          !prefersReducedMotion && "animate-in fade-in zoom-in-[0.97] slide-in-from-bottom-4 duration-200 ease-out",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] bg-[var(--chalk-app-danger)]/10 text-[var(--chalk-app-danger)]">
              <CallEnd01Icon size={22} />
            </div>

            <div>
              <h2 id="leave-modal-title" className="text-xl font-semibold tracking-[-0.025em]">
                {confirmingEndEpisode ? "End Episode for everyone?" : "Leave this Space?"}
              </h2>
              <p id="leave-modal-description" className="mt-2 text-sm leading-6 text-[var(--chalk-app-text-muted)]">
                {confirmingEndEpisode ? "This ends the live Episode for every Participant. Everyone will be disconnected, and this action cannot be undone." : "You’ll leave your connection to this Space. Other Participants can continue, and you can re-enter with the Space link."}
              </p>
            </div>
          </div>

          {activeError ? (
            <p id="leave-modal-error" role="alert" className="mt-5 rounded-[8px] border border-[var(--chalk-app-danger)]/35 bg-[var(--chalk-app-danger)]/10 px-3 py-2 text-sm leading-5 text-[var(--chalk-app-danger)]">
              {activeError}
            </p>
          ) : null}

          {confirmingEndEpisode ? (
            <div className="mt-6 rounded-[10px] border border-[var(--chalk-app-danger)]/35 bg-[var(--chalk-app-danger)]/10 p-4 text-sm text-[var(--chalk-app-text)]">
              <p className="font-semibold text-[var(--chalk-app-danger)]">This affects everyone in the Episode.</p>
              <p className="mt-1 leading-5 text-[var(--chalk-app-text-muted)]">Use this only when the Episode should end for all Participants.</p>
            </div>
          ) : null}

          <div className="mt-7 flex gap-3">
            <button
              ref={initialFocusRef}
              type="button"
              disabled={isPending}
              onClick={confirmingEndEpisode ? () => setConfirmingEndEpisode(false) : onClose}
              data-chalk-action={confirmingEndEpisode ? "back" : "cancel-leave"}
              className="h-11 flex-1 rounded-[8px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-control)] text-sm font-semibold text-[var(--chalk-app-text)] outline-none transition hover:bg-[var(--chalk-app-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]"
            >
              {confirmingEndEpisode ? "Back" : "Cancel"}
            </button>
            <button
              type="button"
              disabled={confirmingEndEpisode ? !canEndEpisodeAction || endEpisodePending : leavePending}
              aria-busy={confirmingEndEpisode ? endEpisodePending : leavePending}
              onClick={confirmingEndEpisode ? onEndEpisode : onConfirm}
              data-chalk-action={confirmingEndEpisode ? "end-episode" : "leave-space"}
              className={cn(
                "h-11 flex-1 rounded-[8px] bg-[var(--chalk-app-danger)] text-sm font-semibold text-white outline-none transition hover:bg-[var(--chalk-app-danger-hover)] disabled:cursor-not-allowed disabled:opacity-55",
                "focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-danger)] focus-visible:ring-offset-2",
                "active:scale-[0.98]",
              )}
            >
              {confirmingEndEpisode ? (endEpisodePending ? "Ending Episode…" : "End Episode for everyone") : leavePending ? "Leaving…" : leaveError ? "Try leaving again" : "Leave Space"}
            </button>
          </div>
          {!confirmingEndEpisode && canEndEpisodeAction ? (
            <div className="mt-5 rounded-[10px] border border-[var(--chalk-app-danger)]/30 bg-[var(--chalk-app-control)] p-4">
              <p className="text-sm font-semibold text-[var(--chalk-app-text)]">End the Episode</p>
              <p className="mt-1 text-xs leading-5 text-[var(--chalk-app-text-muted)]">Disconnect every Participant and close this Episode.</p>
              <button
                type="button"
                disabled={isPending}
                onClick={() => setConfirmingEndEpisode(true)}
                data-chalk-action="open-end-episode-confirmation"
                className="mt-3 h-10 w-full rounded-[8px] border border-[var(--chalk-app-danger)] bg-[var(--chalk-app-control)] text-sm font-semibold text-[var(--chalk-app-danger)] outline-none transition hover:bg-[var(--chalk-app-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-danger)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-55"
              >
                End Episode for everyone
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

ClassicLeaveDialog.displayName = "LeaveDialog";
