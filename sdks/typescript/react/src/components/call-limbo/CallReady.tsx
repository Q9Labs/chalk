"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useIsMobile, usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkCopyButton, ChalkSheet } from "../chalk-ui";
import { inviteQR } from "./qr-code";

export interface CallReadyProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly link?: string;
}
export function CallReady({ open, onClose, link = typeof location === "undefined" ? "" : location.href }: CallReadyProps) {
  const [showQR, setShowQR] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const phone = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();
  const [entered, setEntered] = useState(false);
  const [present, setPresent] = useState(open);
  const id = useId();
  const qr = showQR ? inviteQR(link) : null;
  const close = () => {
    onClose();
    cardRef.current?.closest("[data-chalk]")?.querySelector<HTMLButtonElement>("[data-call-link-trigger]")?.focus();
  };
  useEffect(() => {
    if (!open && cardRef.current?.contains(document.activeElement)) cardRef.current.closest("[data-chalk]")?.querySelector<HTMLButtonElement>("[data-call-link-trigger]")?.focus();
  }, [open]);
  useEffect(() => {
    if (!showQR || reducedMotion) return;
    const animation = qrRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    return () => animation?.cancel();
  }, [showQR, reducedMotion]);
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
      <div className="-mt-1.5 mb-0.5 flex items-center justify-between">
        <h2 id={id} data-part="ready-title" tabIndex={-1} style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, fontFamily: "inherit", letterSpacing: "normal", textWrap: "wrap", outline: "none" }}>
          Your call is ready
        </h2>
        <button type="button" data-part="ready-dismiss" className="chalk-dismiss max-sm:!h-11 max-sm:!w-11" aria-label="Close call link" onClick={close}>
          <svg width="20" height="20" style={{ width: 20, height: 20 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </div>
      <p className="mr-1 text-[13px] text-[var(--chalk-muted-text)]">Share this link with people you want in the call</p>
      <div data-part="ready-link" style={{ borderRadius: 999 }} className="mt-3 flex h-11 items-center justify-between gap-2 bg-[var(--chalk-raised)] pl-3.5 pr-1 font-medium">
        <span className="min-w-0 truncate">{link.replace(/^https?:\/\//, "")}</span>
        <span className="flex gap-0.5">
          <button type="button" className="chalk-copy" aria-label={showQR ? "Hide QR code" : "Show QR code"} aria-expanded={showQR} aria-controls={`${id}-qr`} onClick={() => setShowQR(!showQR)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM19 15h2v6h-6v-2" />
            </svg>
          </button>
          <ChalkCopyButton text={link} announcement="Copied" />
        </span>
      </div>
      <div ref={qrRef} id={`${id}-qr`} hidden={!showQR}>
        <div className="mt-3 flex items-center gap-3.5">
          {qr ? (
            <svg role="img" aria-label="Scan to join this call" width="104" height="104" viewBox={`-4 -4 ${qr.length + 8} ${qr.length + 8}`} className="shrink-0 rounded-lg bg-white p-1" shapeRendering="crispEdges">
              <path fill="#000" d={qr.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("")} />
            </svg>
          ) : null}
          <p className="text-[13px] text-[var(--chalk-soft-text)]">{qr ? "Scan with a phone camera to join this call." : "This link is too long for a QR code. Copy the link to share it."}</p>
        </div>
      </div>
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
        <section ref={cardRef} aria-labelledby={id}>
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
      style={{ borderRadius: 16, opacity: entered ? 1 : 0, transform: entered ? "none" : "translateY(8px)", transition: reducedMotion ? "none" : "opacity .2s cubic-bezier(.16,1,.3,1), transform .2s cubic-bezier(.16,1,.3,1)" }}
      className="absolute bottom-[76px] left-5 z-40 w-80 rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] pb-4 pl-4 pr-3 pt-3.5 text-[var(--chalk-text)]"
    >
      {content}
    </section>
  ) : null;
}
