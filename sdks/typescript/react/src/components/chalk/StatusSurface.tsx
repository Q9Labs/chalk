"use client";

import type React from "react";
import { chalkThemeStyle, type ChalkTheme } from "../../theme";

export type StatusSurfacePhase = "entering" | "left" | "episode-ended" | "failed" | "removed" | "full" | "elsewhere";
export interface StatusSurfaceProps {
  readonly phase: StatusSurfacePhase;
  readonly callName?: string;
  readonly reason?: string;
  readonly theme?: ChalkTheme;
  readonly onRejoin?: () => void;
  readonly onHome?: () => void;
  readonly onRetry?: () => void;
  readonly onReportProblem?: () => void;
  readonly rejoinDisabled?: boolean;
  readonly retryPending?: boolean;
}

/** All terminal call states share the same quiet page and host-owned navigation. */
export function StatusSurface({ phase, callName = "the call", reason, theme, onRejoin, onHome, onRetry, onReportProblem, rejoinDisabled = false, retryPending = false }: StatusSurfaceProps): React.JSX.Element {
  const copy = {
    entering: { title: `Joining ${callName}…`, detail: "" },
    left: { title: `You left ${callName}`, detail: "" },
    "episode-ended": { title: "The call ended", detail: "" },
    failed: { title: `Couldn’t connect to ${callName}`, detail: "Check your internet connection, then try again." },
    removed: { title: `You were removed from ${callName}`, detail: "The host removed you from this call." },
    full: { title: "This call is full", detail: `${callName} has reached 100 people. Ask the host to make room, then try again.` },
    elsewhere: { title: "You joined from another tab", detail: `${callName} is open in another tab or window. Use it here instead?` },
  }[phase];
  const retry = onRejoin ?? onRetry;
  const canRetry = phase === "left" || phase === "failed" || phase === "full" || phase === "elsewhere";
  return (
    <main
      data-chalk
      data-chalk-theme={theme?.colorScheme ?? "dark"}
      data-chalk-status={phase}
      style={{ ...chalkThemeStyle(theme), fontSize: 14, lineHeight: 1.4 }}
      className="chalk-root relative flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 bg-[var(--chalk-canvas)] p-6 text-center text-[var(--chalk-text)]"
    >
      <h1 role={phase === "entering" ? "status" : undefined} className="text-[22px] font-semibold">
        {copy.title}
      </h1>
      {reason || copy.detail ? <p className="text-[14px] text-[var(--chalk-muted-text)]">{reason ?? copy.detail}</p> : null}
      <div data-part="status-actions" className="mt-5 flex gap-7">
        {canRetry && retry ? <StatusAction icon={<StatusIcon retry />} label={phase === "elsewhere" ? "Use here" : phase === "left" ? "Rejoin" : "Try again"} onClick={retry} disabled={rejoinDisabled || retryPending} /> : null}
        {phase !== "entering" && onHome ? <StatusAction icon={<StatusIcon />} label="Home" onClick={onHome} /> : null}
      </div>
      {onReportProblem && phase !== "entering" ? (
        <button type="button" onClick={onReportProblem} className="mt-[18px] px-2.5 py-2 text-[13px] text-[var(--chalk-muted-text)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
          Report a problem
        </button>
      ) : null}
    </main>
  );
}

function StatusIcon({ retry = false }: { readonly retry?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {retry ? (
        <>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </>
      ) : (
        <path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
      )}
    </svg>
  );
}

function StatusAction({ icon, label, onClick, disabled }: { readonly icon: React.ReactNode; readonly label: string; readonly onClick: () => void; readonly disabled?: boolean }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="group flex flex-col items-center gap-2 text-[13px] font-medium text-[var(--chalk-soft-text)] outline-none disabled:pointer-events-none disabled:opacity-50">
      <span
        aria-hidden="true"
        data-part="status-action-circle"
        className="grid h-14 w-14 place-items-center rounded-full bg-[var(--chalk-raised)] text-[var(--chalk-text)] transition-transform duration-150 ease-out group-hover:bg-[var(--chalk-hover)] group-active:scale-[.94] group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-[var(--chalk-text)] motion-reduce:transition-none"
      >
        {icon}
      </span>
      {label}
    </button>
  );
}
