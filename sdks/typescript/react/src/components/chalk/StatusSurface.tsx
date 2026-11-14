"use client";

import type React from "react";
import { getConnectionFailureDetail, type ClientFailure, type ErrorCode } from "@q9labsai/chalk-client";
import { chalkThemeStyle, type ChalkTheme } from "../../theme";

export type StatusSurfacePhase = "entering" | "left" | "timed-out" | "episode-ended" | "failed" | "removed" | "full" | "elsewhere";
export interface StatusSurfaceProps {
  readonly phase: StatusSurfacePhase;
  readonly callName?: string;
  readonly reason?: string;
  readonly episodeEndReason?: string;
  readonly endAction?: { readonly label: string; readonly onClick: () => void };
  readonly errorCode?: ErrorCode;
  readonly sync?: ClientFailure["sync"];
  readonly theme?: ChalkTheme;
  readonly onRejoin?: () => void;
  readonly onHome?: () => void;
  readonly onRetry?: () => void;
  readonly onReportProblem?: () => void;
  readonly rejoinDisabled?: boolean;
  readonly retryPending?: boolean;
}

/** All terminal call states share the same quiet page and host-owned navigation. */
export function StatusSurface({ phase, callName = "the call", reason, episodeEndReason, endAction, errorCode, sync, theme, onRejoin, onHome, onRetry, onReportProblem, rejoinDisabled = false, retryPending = false }: StatusSurfaceProps): React.JSX.Element {
  const connectionLost = phase === "failed" && errorCode === "connection.sync_recovery_exhausted";
  const copy = {
    entering: { title: `Joining ${callName}…`, detail: "" },
    left: { title: `You left ${callName}`, detail: "" },
    "timed-out": { title: `You were disconnected from ${callName}`, detail: "Your connection was lost for too long, so your seat was released. Rejoin to come back." },
    "episode-ended": episodeEndReason === "maximum_duration" ? { title: "The call reached its time limit", detail: "This call has ended for everyone." } : { title: "The call ended", detail: "" },
    failed: { title: connectionLost ? "Connection lost" : `Couldn’t connect to ${callName}`, detail: getConnectionFailureDetail({ code: errorCode, sync }) },
    removed: { title: `You were removed from ${callName}`, detail: "The host removed you from this call." },
    full: { title: "This call is full", detail: `${callName} has reached 100 people. Ask the host to make room, then try again.` },
    elsewhere: { title: "You joined from another tab", detail: `${callName} is open in another tab or window. Use it here instead?` },
  }[phase];
  const retry = onRejoin ?? onRetry;
  const canRetry = phase === "left" || phase === "timed-out" || phase === "failed" || phase === "full" || phase === "elsewhere";
  return (
    <main
      data-chalk
      data-chalk-theme={theme?.colorScheme ?? "dark"}
      data-chalk-status={phase}
      style={{ ...chalkThemeStyle(theme), fontSize: "var(--type-body)", lineHeight: 1.4 }}
      className="chalk-root relative flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 bg-[var(--chalk-canvas)] p-6 text-center text-[var(--chalk-text)]"
    >
      <h1 role={phase === "entering" ? "status" : undefined} style={{ fontSize: "var(--type-title)", fontWeight: 600, lineHeight: 1.4, fontFamily: "inherit", letterSpacing: "normal", textWrap: "wrap" }}>
        {copy.title}
      </h1>
      {reason || copy.detail ? <p className="text-(length:--type-body) text-[var(--chalk-muted-text)]">{reason ?? copy.detail}</p> : null}
      <div data-part="status-actions" className="mt-5 flex gap-7">
        {phase === "episode-ended" && episodeEndReason === "maximum_duration" && endAction ? <StatusAction icon={<StatusIcon kind="forward" />} label={endAction.label} onClick={endAction.onClick} /> : null}
        {canRetry && retry ? <StatusAction icon={<StatusIcon kind="retry" />} label={phase === "elsewhere" ? "Use here" : phase === "left" || phase === "timed-out" || connectionLost ? "Rejoin" : "Try again"} onClick={retry} disabled={rejoinDisabled || retryPending} /> : null}
        {phase !== "entering" && onHome ? <StatusAction icon={<StatusIcon kind="home" />} label="Home" onClick={onHome} /> : null}
      </div>
      {onReportProblem && phase !== "entering" ? (
        <button type="button" onClick={onReportProblem} className="mt-(--space-4) px-2.5 py-2 text-(length:--type-body-sm) text-[var(--chalk-muted-text)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
          Report a problem
        </button>
      ) : null}
    </main>
  );
}

const STATUS_ICON = {
  retry: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  forward: <path d="M5 12h14M13 6l6 6-6 6" />,
  home: <path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
};

function StatusIcon({ kind }: { readonly kind: keyof typeof STATUS_ICON }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {STATUS_ICON[kind]}
    </svg>
  );
}

function StatusAction({ icon, label, onClick, disabled }: { readonly icon: React.ReactNode; readonly label: string; readonly onClick: () => void; readonly disabled?: boolean }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={{ fontSize: "var(--type-body-sm)", fontWeight: 500, lineHeight: 1.4 }} className="group flex flex-col items-center gap-2 text-[var(--chalk-soft-text)] outline-none disabled:pointer-events-none disabled:opacity-50">
      <span
        aria-hidden="true"
        data-part="status-action-circle"
        style={{ borderRadius: "50%", color: "var(--chalk-text)" }}
        className="grid h-14 w-14 place-items-center rounded-full bg-[var(--chalk-raised)] text-[var(--chalk-text)] transition-transform duration-150 ease-out group-hover:bg-[var(--chalk-hover)] group-active:scale-[.94] group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-[var(--chalk-text)] motion-reduce:transition-none"
      >
        {icon}
      </span>
      {label}
    </button>
  );
}
