"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useIsMobile, usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkSheet } from "../chalk-ui";
import { InviteLinkButton } from "../chalk-ui/InviteLinkButton";
import { InviteQR, canEncodeInviteQr } from "../chalk-ui/InviteQR";

export interface CallReadyProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly link?: string;
}
export function CallReady({ open, onClose, link = typeof location === "undefined" ? "" : location.href }: CallReadyProps) {
  const cardRef = useRef<HTMLElement>(null);
  const phone = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();
  const [entered, setEntered] = useState(false);
  const [present, setPresent] = useState(open);
  const id = useId();
  const qr = canEncodeInviteQr(link);
  const close = () => {
    onClose();
    cardRef.current?.closest("[data-chalk]")?.querySelector<HTMLButtonElement>("[data-call-link-trigger]")?.focus();
  };
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Return focus to the call-link trigger when the card closes.
  useEffect(() => {
    if (!open && cardRef.current?.contains(document.activeElement)) cardRef.current.closest("[data-chalk]")?.querySelector<HTMLButtonElement>("[data-call-link-trigger]")?.focus();
  }, [open]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [animation] Retain the card through its exit and stage entry on a frame; cancel frame and timeout on cleanup.
  useEffect(() => {
    if (open) setPresent(true);
    const frame = requestAnimationFrame(() => setEntered(open));
    const timer = setTimeout(
      () => {
        if (!open) setPresent(false);
      },
      reducedMotion ? 0 : 200,
    );
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [open, reducedMotion]);
  const content = (
    <>
      <div className="flex items-center justify-between pb-2 pl-3 pr-1 pt-1">
        <h2 id={id} data-part="ready-title" tabIndex={-1} style={{ fontSize: "var(--type-body-lg)", fontWeight: 600, lineHeight: 1.4, fontFamily: "inherit", letterSpacing: "normal", textWrap: "wrap", outline: "none" }}>
          Your call is ready
        </h2>
        <button type="button" data-part="ready-dismiss" className="chalk-dismiss !h-8 !w-8 max-sm:!h-11 max-sm:!w-11" aria-label="Close call link" onClick={close}>
          <svg width="18" height="18" style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </div>
      {qr ? (
        <div className="grid place-items-center px-5 pb-4 pt-3">
          <InviteQR value={link} />
        </div>
      ) : (
        <p className="px-3 pb-3 text-(length:--type-body-sm) text-[var(--chalk-muted-text)]">This link is too long for a QR code. Copy the link to share it.</p>
      )}
      <InviteLinkButton link={link} variant="card" />
    </>
  );
  if (phone)
    return (
      <ChalkSheet
        variant="ready"
        open={open}
        onOpenChange={(value) => {
          if (!value) onClose();
        }}
        title="Your call is ready"
      >
        <section ref={cardRef} aria-labelledby={id} className="grid gap-1">
          {content}
        </section>
      </ChalkSheet>
    );
  return present ? (
    <section
      ref={cardRef}
      data-part="call-ready"
      aria-labelledby={id}
      aria-hidden={!open}
      inert={!open}
      style={{ opacity: entered ? 1 : 0, transform: entered ? "none" : "translateY(8px)", transition: reducedMotion ? "none" : "opacity .2s cubic-bezier(.16,1,.3,1), transform .2s cubic-bezier(.16,1,.3,1)" }}
      className="absolute bottom-[76px] left-5 z-40 grid w-[296px] gap-1 rounded-[var(--corner-3xl)] border border-[var(--chalk-line-strong)] bg-[var(--chalk-popover)] p-2 shadow-(--elevation-menu) text-[var(--chalk-text)]"
    >
      {content}
    </section>
  ) : null;
}
