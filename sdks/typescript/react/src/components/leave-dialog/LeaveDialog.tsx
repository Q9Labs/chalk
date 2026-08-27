import React, { useEffect, useRef, useState } from "react";
import { CallEnd01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { resolvePortalThemeFromDocument } from "../../utils/theme";
import { getThemeMode, type ThemePalette, type ThemeTexture } from "../theme";
import { ChalkBackdrop, ChalkBadge, ChalkButton, ChalkDialogPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicLeaveDialog } from "./ClassicLeaveDialog";

export interface LeaveDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly onEndEpisode?: () => void;
  /** Set this to false when the current Participant cannot end the Episode. */
  readonly canEndEpisode?: boolean;
  readonly leavePending?: boolean;
  readonly leaveError?: string | null;
  readonly endEpisodePending?: boolean;
  readonly endEpisodeError?: string | null;
  readonly palette?: ThemePalette;
  readonly texture?: ThemeTexture;
  readonly className?: string;
}

const ChalkLeaveDialog = React.memo<LeaveDialogProps>(({ isOpen, onClose, onConfirm, onEndEpisode, canEndEpisode = true, leavePending = false, leaveError, endEpisodePending = false, endEpisodeError, palette, texture = "none", className }: LeaveDialogProps) => {
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
    <div data-chalk data-chalk-skin={skin} data-chalk-theme={resolvedTheme} data-chalk-palette={palette} data-chalk-texture={texture} className={cn("chalk-root fixed inset-0 z-[100]", !prefersReducedMotion && "animate-in fade-in duration-200", className)} onClick={handleBackdropClick}>
      <ChalkBackdrop className="z-0 !bg-[color-mix(in_srgb,var(--chalk-app-canvas)_65%,transparent)] !backdrop-blur-[2px]" />
      <div className="relative z-10 flex h-full items-center justify-center p-4">
        <ChalkDialogPanel
          ref={modalRef}
          className={cn(
            "chalk-textured-surface relative w-full max-w-[420px] overflow-hidden !rounded-[12px] !border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)] !p-0 shadow-[var(--chalk-app-shadow-sm)]",
            !prefersReducedMotion && "animate-in fade-in zoom-in-[0.97] slide-in-from-bottom-4 duration-200 ease-out",
          )}
          aria-modal="true"
          aria-labelledby="leave-modal-title"
          aria-describedby="leave-modal-description"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-6">
            <div className="flex items-start gap-4">
              <ChalkBadge tone={confirmingEndEpisode ? "danger" : "neutral"} className="!h-11 !w-11 !shrink-0 !rounded-[8px] !p-0 text-[var(--chalk-app-danger)]">
                <CallEnd01Icon size={22} />
              </ChalkBadge>

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
              <ChalkButton
                ref={initialFocusRef}
                variant="outline"
                type="button"
                disabled={isPending}
                onClick={confirmingEndEpisode ? () => setConfirmingEndEpisode(false) : onClose}
                data-chalk-action={confirmingEndEpisode ? "back" : "cancel-leave"}
                className="!h-11 !flex-1 !rounded-[8px] !border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-control)] !text-sm !font-semibold text-[var(--chalk-app-text)] outline-none transition hover:bg-[var(--chalk-app-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]"
              >
                {confirmingEndEpisode ? "Back" : "Cancel"}
              </ChalkButton>
              <ChalkButton
                variant="solid"
                tone="danger"
                type="button"
                loading={confirmingEndEpisode ? endEpisodePending : leavePending}
                disabled={confirmingEndEpisode ? !canEndEpisodeAction : false}
                onClick={confirmingEndEpisode ? onEndEpisode : onConfirm}
                data-chalk-action={confirmingEndEpisode ? "end-episode" : "leave-space"}
                className={cn(
                  "!h-11 !flex-1 !rounded-[8px] !text-sm !font-semibold !text-[var(--chalk-app-control-active-text)] outline-none transition hover:bg-[var(--chalk-app-danger-hover)]",
                  "focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-danger)] focus-visible:ring-offset-2",
                  "active:scale-[0.98]",
                )}
              >
                {confirmingEndEpisode ? "End Episode for everyone" : leaveError ? "Try leaving again" : "Leave Space"}
              </ChalkButton>
            </div>
            {!confirmingEndEpisode && canEndEpisodeAction ? (
              <div className="mt-5 rounded-[10px] border border-[var(--chalk-app-danger)]/30 bg-[var(--chalk-app-control)] p-4">
                <p className="text-sm font-semibold text-[var(--chalk-app-text)]">End the Episode</p>
                <p className="mt-1 text-xs leading-5 text-[var(--chalk-app-text-muted)]">Disconnect every Participant and close this Episode.</p>
                <ChalkButton
                  variant="outline"
                  tone="danger"
                  type="button"
                  disabled={isPending}
                  onClick={() => setConfirmingEndEpisode(true)}
                  data-chalk-action="open-end-episode-confirmation"
                  className="mt-3 !h-10 !w-full !rounded-[8px] !text-sm !font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-danger)] focus-visible:ring-offset-2"
                >
                  End Episode for everyone
                </ChalkButton>
              </div>
            ) : null}
          </div>
        </ChalkDialogPanel>
      </div>
    </div>
  );
});

ChalkLeaveDialog.displayName = "ChalkLeaveDialog";

export const LeaveDialog = React.memo<LeaveDialogProps>((props: LeaveDialogProps) => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicLeaveDialog {...props} /> : <ChalkLeaveDialog {...props} />;
});

LeaveDialog.displayName = "LeaveDialog";
