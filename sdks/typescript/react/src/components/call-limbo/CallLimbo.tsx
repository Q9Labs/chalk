"use client";

import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { chalkThemeStyle, type ChalkTheme } from "../../theme";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { CallEventIcon } from "../toast-stack/CallEventIcon";
import { ChalkButton } from "../chalk-ui";
import { cn } from "../../utils/cn";

export interface CallLimboProps {
  readonly spaceName?: string;
  readonly message: string;
  readonly detail?: string;
  readonly recorded?: boolean;
  readonly action?: { readonly label: string; readonly onClick: () => void; readonly disabled?: boolean };
  readonly children?: ReactNode;
  /** Overlay the admitted call instead of rendering the privacy-safe stand-in. */
  readonly overlay?: boolean;
  readonly active?: boolean;
  /** Start covered when the real call first replaces the stand-in. */
  readonly initiallyCovered?: boolean;
  readonly theme?: ChalkTheme;
  readonly blocking?: boolean;
  /** Extra classes for the message card, such as a fixed width around a form. */
  readonly className?: string;
}

/** One surface for joining, admission and connection recovery. Never renders participant data. */
export function CallLimbo({ spaceName = "Call", message, detail, action, children, overlay = false, active = true, initiallyCovered = false, theme, recorded = false, blocking = true, className }: CallLimboProps): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [covered, setCovered] = useState(active || initiallyCovered);
  useEffect(() => {
    let nextFrame = 0;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => setCovered(active));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
    };
  }, [active]);
  useEffect(() => {
    if (!overlay || !active || !layerRef.current) return;
    const root = layerRef.current.closest("[data-chalk]");
    if (!root) return;
    const previousFocus = document.activeElement;
    const siblings: { element: HTMLElement; inert: boolean; filter: string }[] = [];
    let branch: HTMLElement = layerRef.current;
    while (branch !== root && branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          siblings.push({ element: sibling, inert: sibling.inert, filter: sibling.style.filter });
          if (blocking) sibling.inert = true;
          if (!blocking) sibling.style.filter = root.getAttribute("data-chalk-theme") === "light" ? "blur(10px) grayscale(.75)" : "blur(10px) grayscale(.75) brightness(.6)";
        }
      }
      branch = branch.parentElement;
    }
    if (blocking) layerRef.current.focus({ preventScroll: true });
    return () => {
      for (const { element, inert, filter } of siblings) {
        if (blocking) element.inert = inert;
        element.style.filter = filter;
      }
      if (blocking && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [active, blocking, overlay]);
  const stacked = blocking && (children ? "name" : message.endsWith("…") ? "entering" : detail && action ? "waiting" : null);
  const layer = (
    <div
      ref={layerRef}
      tabIndex={-1}
      data-call-limbo
      data-covered={covered}
      aria-hidden={!active}
      className={cn("absolute inset-0 z-50 flex items-center justify-center px-6 text-[var(--chalk-app-text)]", blocking && "bg-[var(--chalk-app-canvas)]")}
      style={{
        pointerEvents: active && blocking ? "auto" : "none",
        opacity: covered ? 1 : 0,
        transition: reducedMotion ? "none" : "opacity 220ms cubic-bezier(.2,.8,.2,1)",
      }}
    >
      <div data-part={active ? "limbo-message" : undefined} style={{ borderRadius: 16 }} className={cn("flex max-w-full flex-col items-center gap-2 rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] px-7 py-[22px] text-center", stacked && "w-[340px] py-8", className)}>
        {stacked ? (
          <span aria-hidden="true" className="mb-1 flex h-8 items-center text-[var(--chalk-soft-text)] [&>svg]:h-8 [&>svg]:w-8">
            {stacked === "name" ? <CallEventIcon kind="host" /> : null}
            {stacked === "waiting" ? <CallEventIcon kind="hand" /> : null}
            {stacked === "entering" ? <span className="h-7 w-7 animate-spin rounded-full border-2 border-[var(--chalk-line-strong)] border-t-[var(--chalk-text)] motion-reduce:animate-none" /> : null}
          </span>
        ) : null}
        {message ? (
          <p role={active ? "status" : undefined} className={cn("flex items-center gap-2.5 font-semibold", stacked ? "text-[18px]" : "text-[17px]")}>
            {message.endsWith("…") && !stacked ? <span aria-hidden="true" className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-[var(--chalk-line-strong)] border-t-[var(--chalk-text)] motion-reduce:animate-none" /> : null}
            {message}
          </p>
        ) : null}
        {detail ? <p className="text-sm leading-[1.4] text-[var(--chalk-soft-text)]">{detail}</p> : null}
        {recorded ? (
          <p className="mt-1 flex items-center gap-1.5 text-xs leading-[1.4] text-[var(--chalk-muted-text)]">
            <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">
              <CallEventIcon kind="recording" error />
            </span>
            This call is recorded. By joining, you agree to be recorded.
          </p>
        ) : null}
        {stacked === "waiting" ? (
          <span aria-hidden="true" className="mt-3 flex gap-1.5">
            {[0, 1, 2].map((dot) => (
              <span key={dot} className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--chalk-muted-text)] motion-reduce:animate-none" style={{ animationDelay: `${dot * 200}ms` }} />
            ))}
          </span>
        ) : null}
        {children}
        {action ? (
          <ChalkButton className={cn("mt-6 !h-11", stacked && "w-full")} variant="outline" onClick={action.onClick} disabled={action.disabled}>
            {action.label}
          </ChalkButton>
        ) : null}
      </div>
    </div>
  );
  if (overlay) return layer;
  return (
    <div data-chalk data-chalk-theme={theme?.colorScheme ?? "dark"} className="chalk-root relative h-full min-h-0 w-full overflow-hidden bg-[var(--chalk-app-canvas)]" style={{ ...chalkThemeStyle(theme), fontSize: 14, lineHeight: 1.4 }}>
      <div aria-hidden="true" className="absolute left-5 top-5 text-sm font-medium text-[var(--chalk-muted-text)]">
        {spaceName}
      </div>
      {layer}
    </div>
  );
}
