"use client";

import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { chalkThemeStyle, type ChalkTheme } from "../../theme";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkButton } from "../chalk-ui";

export interface CallLimboProps {
  readonly spaceName?: string;
  readonly message: string;
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void; readonly disabled?: boolean };
  readonly children?: ReactNode;
  /** Overlay the admitted call instead of rendering the privacy-safe stand-in. */
  readonly overlay?: boolean;
  readonly active?: boolean;
  /** Start covered when the real call first replaces the stand-in. */
  readonly initiallyCovered?: boolean;
  readonly theme?: ChalkTheme;
}

/** One surface for joining, admission and connection recovery. Never renders participant data. */
export function CallLimbo({ spaceName = "Call", message, detail, action, children, overlay = false, active = true, initiallyCovered = false, theme }: CallLimboProps): React.JSX.Element {
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
    const siblings: { element: HTMLElement; inert: boolean }[] = [];
    let branch: HTMLElement = layerRef.current;
    while (branch !== root && branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          siblings.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    layerRef.current.focus({ preventScroll: true });
    return () => {
      for (const { element, inert } of siblings) element.inert = inert;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [active, overlay]);
  const layer = (
    <div
      ref={layerRef}
      tabIndex={-1}
      data-call-limbo
      data-covered={covered}
      aria-hidden={!active}
      className="absolute inset-0 z-50 flex items-center justify-center px-6 text-[var(--chalk-app-text)]"
      style={{
        pointerEvents: active ? "auto" : "none",
        backdropFilter: reducedMotion ? "blur(12px)" : `blur(${covered ? 12 : 0}px)`,
        background: covered ? "color-mix(in srgb, var(--chalk-app-control-primary) 18%, transparent)" : "transparent",
        opacity: reducedMotion && !covered ? 0 : 1,
        transition: reducedMotion ? "opacity 350ms ease" : "backdrop-filter 350ms ease, background 350ms ease",
      }}
    >
      <div className="w-full max-w-sm text-center" style={{ opacity: covered ? 1 : 0, transition: "opacity 200ms ease" }}>
        {message ? (
          <p role={active ? "status" : undefined} className="inline-block max-w-full text-lg font-medium tracking-[-0.02em]" style={overlay ? { background: "color-mix(in srgb, var(--chalk-app-canvas) 92%, transparent)", borderRadius: "1rem", padding: "12px 16px" } : undefined}>
            {message}
          </p>
        ) : null}
        {detail ? <p className="mt-2 text-sm text-[var(--chalk-app-text-muted)]">{detail}</p> : null}
        {children}
        {action ? (
          <ChalkButton className="mt-6 !h-11" variant="outline" onClick={action.onClick} disabled={action.disabled}>
            {action.label}
          </ChalkButton>
        ) : null}
      </div>
    </div>
  );
  if (overlay) return layer;
  return (
    <div data-chalk data-chalk-theme={theme?.colorScheme === "dark" ? "dark" : "light"} className="chalk-root relative h-full min-h-0 w-full overflow-hidden bg-[var(--chalk-app-canvas)]" style={chalkThemeStyle(theme)}>
      <div aria-hidden="true" inert className="absolute inset-0 flex flex-col p-5">
        <div className="text-sm font-medium text-[var(--chalk-app-text)]">{spaceName}</div>
        <div className="my-5 flex-1 rounded-2xl border border-[var(--chalk-app-line-strong)]" style={{ background: "color-mix(in srgb, var(--chalk-app-text) 12%, var(--chalk-app-stage))" }} />
        <div className="mx-auto flex h-16 items-center gap-3 rounded-2xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-4">
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} className="h-9 w-9 rounded-full border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-control)]" />
          ))}
        </div>
      </div>
      {layer}
    </div>
  );
}
