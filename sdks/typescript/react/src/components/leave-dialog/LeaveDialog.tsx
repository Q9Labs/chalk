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
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onEndEpisode?: () => void;
  palette?: ThemePalette;
  texture?: ThemeTexture;
  className?: string;
}

const ChalkLeaveDialog = React.memo<LeaveDialogProps>(({ isOpen, onClose, onConfirm, onEndEpisode, palette, texture = "none", className }: LeaveDialogProps) => {
  const skin = useSkin();
  const prefersReducedMotion = usePrefersReducedMotion();
  const portalTheme = resolvePortalThemeFromDocument();
  const modalRef = useRef<HTMLDivElement>(null);
  const [confirmingEndEpisode, setConfirmingEndEpisode] = useState(false);

  useEffect(() => {
    if (!isOpen) setConfirmingEndEpisode(false);
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  // Close when clicking backdrop
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
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-6">
            <div className="flex items-start gap-4">
              <ChalkBadge tone="danger" className="!h-11 !w-11 !shrink-0 !rounded-[8px] !p-0 text-[var(--chalk-app-danger)]">
                <CallEnd01Icon size={22} />
              </ChalkBadge>

              <div>
                <h2 id="leave-modal-title" className="text-xl font-semibold tracking-[-0.025em]">
                  {confirmingEndEpisode ? "End Episode for everyone?" : "Leave Space?"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-[var(--chalk-app-text-muted)]">{confirmingEndEpisode ? "This ends the live Episode for every Participant. This action cannot be undone." : "You’ll leave this Space now. The Space link will still work if you need to rejoin."}</p>
              </div>
            </div>

            <div className="mt-7 flex gap-3">
              <ChalkButton
                variant="outline"
                type="button"
                onClick={confirmingEndEpisode ? () => setConfirmingEndEpisode(false) : onClose}
                className="!h-11 !flex-1 !rounded-[8px] !border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-control)] !text-sm !font-semibold text-[var(--chalk-app-text)] outline-none transition hover:bg-[var(--chalk-app-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]"
              >
                {confirmingEndEpisode ? "Back" : "Cancel"}
              </ChalkButton>
              <ChalkButton
                variant="solid"
                tone="danger"
                type="button"
                onClick={confirmingEndEpisode ? onEndEpisode : onConfirm}
                className={cn(
                  "!h-11 !flex-1 !rounded-[8px] !text-sm !font-semibold !text-[var(--chalk-app-control-active-text)] outline-none transition hover:bg-[var(--chalk-app-danger-hover)]",
                  "focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-danger)] focus-visible:ring-offset-2",
                  "active:scale-[0.98]",
                )}
              >
                {confirmingEndEpisode ? "End Episode" : "Leave"}
              </ChalkButton>
            </div>
            {!confirmingEndEpisode && onEndEpisode ? (
              <ChalkButton
                variant="ghost"
                tone="danger"
                type="button"
                onClick={() => setConfirmingEndEpisode(true)}
                className="mt-3 !h-11 !w-full !rounded-[8px] !text-sm !font-semibold text-[var(--chalk-app-danger)] outline-none transition hover:bg-[var(--chalk-app-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]"
              >
                End Episode for everyone
              </ChalkButton>
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
