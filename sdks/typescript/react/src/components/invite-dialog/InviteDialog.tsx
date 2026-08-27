import React, { useEffect, useRef, useState } from "react";
import type { Copy01IconHandle } from "../../utils/animated-icons";
import { Cancel01Icon, Copy01Icon, Mail01Icon, Calendar01Icon, Link01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkBackdrop, ChalkButton, ChalkDialogPanel, ChalkIconButton, ChalkInput, ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicInviteDialog } from "./ClassicInviteDialog";

export interface InviteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  inviteLink: string;
  spaceId?: string;
  onCopyLink?: () => void | Promise<void>;
  onShareEmail?: () => void;
  onShareCalendar?: () => void;
  className?: string;
}

const ChalkInviteDialog = React.memo<InviteDialogProps>(({ isOpen, onClose, inviteLink, spaceId, onCopyLink, onShareEmail, onShareCalendar, className }: InviteDialogProps) => {
  const skin = useSkin();
  const prefersReducedMotion = usePrefersReducedMotion();
  const modalRef = useRef<HTMLDivElement>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const copyIconRef = useRef<Copy01IconHandle>(null);
  const [isCopyFeedbackVisible, setIsCopyFeedbackVisible] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  const handleCopyLink = async () => {
    if (!onCopyLink) return;
    await onCopyLink();
    copyIconRef.current?.startAnimation();
    setIsCopyFeedbackVisible(true);
    if (copyResetTimeoutRef.current) {
      window.clearTimeout(copyResetTimeoutRef.current);
    }
    copyResetTimeoutRef.current = window.setTimeout(() => {
      setIsCopyFeedbackVisible(false);
      copyResetTimeoutRef.current = null;
    }, 1200);
  };

  if (!isOpen) return null;

  return (
    <div data-chalk-skin={skin} className={cn("fixed inset-0 z-50", className)}>
      <ChalkBackdrop className="z-0 !bg-[color-mix(in_srgb,var(--chalk-app-canvas)_65%,transparent)] !backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative z-10 flex h-full items-center justify-center p-4">
        <ChalkDialogPanel
          ref={modalRef}
          className={cn(
            "chalk-textured-surface w-full max-w-md overflow-hidden !rounded-[12px] !border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)] !p-0 shadow-[var(--chalk-app-shadow-sm)]",
            !prefersReducedMotion && "animate-in fade-in zoom-in-[0.97] duration-200",
          )}
          aria-modal="true"
          aria-labelledby="invite-modal-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-[var(--chalk-app-line)] px-5 py-4">
            <h2 id="invite-modal-title" className="text-xl font-semibold tracking-[-0.025em] text-[var(--chalk-app-text)]">
              Invite people
            </h2>
            <ChalkIconButton type="button" onClick={onClose} size="sm" className="!rounded-full !border border-[var(--chalk-app-line)] text-[var(--chalk-app-text-muted)] transition hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)]" aria-label="Close invite dialog">
              <Cancel01Icon size={19} />
            </ChalkIconButton>
          </div>

          <div className="space-y-5 p-5">
            <div className="space-y-4">
              <label className="block text-sm font-medium text-[var(--chalk-app-text)]">
                <span className="mb-2 block">Space link</span>
                <span className="relative block">
                  <Link01Icon size={16} className="pointer-events-none absolute left-3 top-1/2 z-[2] -translate-y-1/2 text-[var(--chalk-app-text-muted)]" />
                  <ChalkInput value={inviteLink} readOnly className="pl-9" onClick={(event) => event.currentTarget.select()} aria-label="Space link" />
                </span>
              </label>
              {onCopyLink && (
                <ChalkButton
                  variant="solid"
                  tone={isCopyFeedbackVisible ? "success" : "accent"}
                  type="button"
                  onClick={handleCopyLink}
                  onMouseEnter={() => copyIconRef.current?.startAnimation()}
                  onFocus={() => copyIconRef.current?.startAnimation()}
                  disabled={isCopyFeedbackVisible}
                  className={cn("!h-11 !w-full !rounded-[8px] !text-sm !font-semibold !text-[var(--chalk-app-control-active-text)] transition-colors", isCopyFeedbackVisible && "cursor-default")}
                >
                  <Copy01Icon ref={copyIconRef} size={18} aria-hidden="true" onMouseEnter={() => copyIconRef.current?.startAnimation()} />
                  {isCopyFeedbackVisible ? "Copied" : "Copy Link"}
                  <span className="sr-only" aria-live="polite">
                    {isCopyFeedbackVisible ? "Copied space link to clipboard" : ""}
                  </span>
                </ChalkButton>
              )}
            </div>

            {spaceId && (
              <ChalkPanel className="flex items-center justify-between !rounded-[8px] !border border-[var(--chalk-app-line)] bg-[var(--chalk-app-input)] !p-3">
                <span className="text-[var(--chalk-app-text-muted)] text-sm">Space ID</span>
                <span className="select-all font-mono text-[var(--chalk-app-text)] text-sm font-medium">{spaceId}</span>
              </ChalkPanel>
            )}

            <div className="grid grid-cols-2 gap-3">
              {onShareEmail && (
                <ChalkButton
                  variant="outline"
                  type="button"
                  onClick={onShareEmail}
                  className="!h-11 !rounded-[8px] !border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-control)] !px-4 !text-sm !font-semibold text-[var(--chalk-app-text)] transition hover:bg-[var(--chalk-app-control-hover)]"
                >
                  <Mail01Icon size={16} />
                  Email
                </ChalkButton>
              )}
              {onShareCalendar && (
                <ChalkButton
                  variant="outline"
                  type="button"
                  onClick={onShareCalendar}
                  className="!h-11 !rounded-[8px] !border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-control)] !px-4 !text-sm !font-semibold text-[var(--chalk-app-text)] transition hover:bg-[var(--chalk-app-control-hover)]"
                >
                  <Calendar01Icon size={16} />
                  Calendar
                </ChalkButton>
              )}
            </div>
          </div>
        </ChalkDialogPanel>
      </div>
    </div>
  );
});

ChalkInviteDialog.displayName = "ChalkInviteDialog";

export const InviteDialog = React.memo<InviteDialogProps>((props: InviteDialogProps) => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicInviteDialog {...props} /> : <ChalkInviteDialog {...props} />;
});

InviteDialog.displayName = "InviteDialog";
