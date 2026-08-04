import React from "react";

import { InformationCircleIcon, LayoutGridIcon, Maximize01Icon, Monitor01Icon, Settings01Icon, UserGroupIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { StatusBadge } from "../atomic/StatusBadge";

export interface SpaceHeaderProps {
  spaceName: string;
  logoUrl?: string;
  duration?: number;
  isRecording?: boolean;
  isTranscribing?: boolean;
  layout?: "grid" | "focus" | "presentation";
  onLayoutChange?: (layout: "grid" | "focus" | "presentation") => void;
  onInvite?: () => void;
  onInfo?: () => void;
  onSettings?: () => void;
  className?: string;
}

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

export const SpaceHeader = React.memo<SpaceHeaderProps>(({ spaceName, logoUrl, duration = 0, isRecording = false, isTranscribing = false, layout = "focus", onLayoutChange, onInvite, onInfo, onSettings, className }) => {
  return (
    <header className={cn("chalk-textured-surface flex h-[76px] shrink-0 items-center justify-between gap-4 border-b border-[var(--chalk-line)] bg-[var(--chalk-chrome)] px-4 text-[var(--chalk-text)] sm:px-7 lg:px-8", className)} role="banner">
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        {logoUrl ? <img src={logoUrl} alt="Chalk" className="h-auto w-[108px] shrink-0 sm:w-[122px]" draggable={false} /> : <span className="shrink-0 text-xl font-bold tracking-tight">Chalk</span>}
        <span className="hidden h-7 w-px bg-[var(--chalk-line)] sm:block" aria-hidden="true" />
        <h1 className="truncate text-sm font-semibold sm:text-base">{spaceName}</h1>
        <span className="hidden font-mono text-xs tabular-nums text-[var(--chalk-muted-text)] sm:block" aria-label={`Space duration ${formatDuration(duration)}`}>
          {formatDuration(duration)}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {isRecording && <StatusBadge status="recording" pulse />}
        {isTranscribing && <StatusBadge status="transcribing" />}
        {onInfo && (
          <button type="button" onClick={onInfo} className="grid h-9 w-9 place-items-center rounded-[8px] text-[var(--chalk-muted-text)] transition hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]" aria-label="Space information">
            <InformationCircleIcon size={18} />
          </button>
        )}
        {onInvite && (
          <button type="button" onClick={onInvite} className="grid h-10 w-10 place-items-center rounded-[7px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] transition hover:border-[var(--chalk-line)] hover:bg-[var(--chalk-stage)]" aria-label="Invite participants">
            <UserGroupIcon size={18} />
          </button>
        )}
        {onLayoutChange && (
          <div className="hidden gap-0.5 rounded-[9px] bg-[var(--chalk-stage)] p-1 sm:flex" role="group" aria-label="Video layout">
            <button
              type="button"
              onClick={() => onLayoutChange("focus")}
              className={cn("grid h-8 w-8 place-items-center rounded-[6px] text-[var(--chalk-muted-text)] transition", layout === "focus" ? "bg-[var(--chalk-surface)] text-[var(--chalk-text)] shadow-[var(--chalk-shadow)]" : "hover:text-[var(--chalk-text)]")}
              aria-label="Spotlight layout"
              aria-pressed={layout === "focus"}
            >
              <Maximize01Icon size={15} />
            </button>
            <button
              type="button"
              onClick={() => onLayoutChange("grid")}
              className={cn("grid h-8 w-8 place-items-center rounded-[6px] text-[var(--chalk-muted-text)] transition", layout === "grid" ? "bg-[var(--chalk-surface)] text-[var(--chalk-text)] shadow-[var(--chalk-shadow)]" : "hover:text-[var(--chalk-text)]")}
              aria-label="Grid layout"
              aria-pressed={layout === "grid"}
            >
              <LayoutGridIcon size={15} />
            </button>
            <button
              type="button"
              onClick={() => onLayoutChange("presentation")}
              className={cn("grid h-8 w-8 place-items-center rounded-[6px] text-[var(--chalk-muted-text)] transition", layout === "presentation" ? "bg-[var(--chalk-surface)] text-[var(--chalk-text)] shadow-[var(--chalk-shadow)]" : "hover:text-[var(--chalk-text)]")}
              aria-label="Presentation layout"
              aria-pressed={layout === "presentation"}
            >
              <Monitor01Icon size={15} />
            </button>
          </div>
        )}
        {onSettings && (
          <button type="button" onClick={onSettings} className="grid h-10 w-10 place-items-center rounded-[7px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] transition hover:border-[var(--chalk-line)] hover:bg-[var(--chalk-stage)]" aria-label="Settings">
            <Settings01Icon size={18} />
          </button>
        )}
      </div>
    </header>
  );
});

SpaceHeader.displayName = "SpaceHeader";
