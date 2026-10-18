"use client";

import type React from "react";

import { chalkThemeStyle, type ChalkTheme } from "../../theme";
import { Home01Icon, RefreshIcon } from "../../utils/icons";

export type StatusSurfacePhase = "entering" | "left" | "episode-ended" | "failed";

export interface StatusSurfaceProps {
  readonly phase: StatusSurfacePhase;
  /** The call's name; the sentence falls back to "the call" without one. */
  readonly callName?: string;
  /** One plain sentence on why the connection failed. */
  readonly reason?: string;
  readonly theme?: ChalkTheme;
  readonly onRejoin?: () => void;
  readonly onHome?: () => void;
  readonly onRetry?: () => void;
  /** True while the client is still closing the connection, so Rejoin cannot start yet. */
  readonly rejoinDisabled?: boolean;
  readonly retryPending?: boolean;
}

/** The one calm dark page shown before a call and after it: a sentence, then round icon actions. */
export function StatusSurface({ phase, callName, reason, theme, onRejoin, onHome, onRetry, rejoinDisabled = false, retryPending = false }: StatusSurfaceProps): React.JSX.Element {
  const name = callName ?? "the call";
  const title = phase === "entering" ? `Joining ${name}…` : phase === "left" ? `You left ${name}` : phase === "episode-ended" ? "The call ended" : `Couldn't connect to ${name}`;
  return (
    <main data-chalk data-chalk-theme="dark" data-chalk-status={phase} style={chalkThemeStyle(theme, "dark")} className="chalk-root grid h-full min-h-0 w-full place-items-center bg-[var(--chalk-canvas)] p-6 text-center text-[var(--chalk-text)]">
      <div className="grid max-w-md justify-items-center gap-6">
        <div className="grid justify-items-center gap-2">
          <h1 role={phase === "entering" ? "status" : undefined} className="text-xl font-semibold tracking-[-0.01em] [text-wrap:balance]">
            {title}
          </h1>
          {phase === "failed" && reason ? <p className="text-sm opacity-70">{reason}</p> : null}
        </div>
        <div className="flex items-start justify-center gap-5">
          {phase === "left" && onRejoin ? <StatusAction icon={<RefreshIcon size={20} />} label="Rejoin" onClick={onRejoin} disabled={rejoinDisabled} /> : null}
          {phase === "failed" && onRetry ? <StatusAction icon={<RefreshIcon size={20} />} label="Try again" onClick={onRetry} disabled={retryPending} /> : null}
          {(phase === "left" || phase === "episode-ended") && onHome ? <StatusAction icon={<Home01Icon size={20} />} label="Home" onClick={onHome} /> : null}
        </div>
      </div>
    </main>
  );
}

function StatusAction({ icon, label, onClick, disabled = false }: { readonly icon: React.ReactNode; readonly label: string; readonly onClick: () => void; readonly disabled?: boolean }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="group grid w-20 justify-items-center gap-2 rounded-lg text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)] disabled:pointer-events-none disabled:opacity-50">
      <span aria-hidden="true" className="grid h-12 w-12 place-items-center rounded-full bg-[var(--chalk-surface)] text-[var(--chalk-text)] transition-colors group-hover:bg-[var(--chalk-line)]">
        {icon}
      </span>
      <span className="opacity-70 transition-opacity group-hover:opacity-100">{label}</span>
    </button>
  );
}
