import React from "react";

import { ColumnIcon, InformationCircleIcon, LayoutGridIcon, Maximize01Icon, Settings01Icon, UserGroupIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { StatusBadge } from "../atomic/StatusBadge";

export interface ConferenceHeaderProps {
  roomName: string;
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

export const ConferenceHeader = React.memo<ConferenceHeaderProps>(({ roomName, logoUrl, duration = 0, isRecording = false, isTranscribing = false, layout = "focus", onLayoutChange, onInvite, onInfo, onSettings, className }) => {
  return (
    <header className={cn("flex h-[76px] shrink-0 items-center justify-between gap-4 border-b border-[#deddd7] bg-[#fbfaf7] px-4 text-[#0c0e12] sm:px-7 lg:px-8", className)} role="banner">
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        {logoUrl ? <img src={logoUrl} alt="Chalk" className="h-auto w-[108px] shrink-0 sm:w-[122px]" draggable={false} /> : <span className="shrink-0 text-xl font-bold tracking-tight">Chalk</span>}
        <span className="hidden h-7 w-px bg-[#deddd7] sm:block" aria-hidden="true" />
        <h1 className="truncate text-sm font-semibold sm:text-base">{roomName}</h1>
        <span className="hidden font-mono text-xs tabular-nums text-[#555b65] sm:block" aria-label={`Meeting duration ${formatDuration(duration)}`}>
          {formatDuration(duration)}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {isRecording && <StatusBadge status="recording" pulse />}
        {isTranscribing && <StatusBadge status="transcribing" />}
        {onInfo && (
          <button type="button" onClick={onInfo} className="grid h-9 w-9 place-items-center rounded-[8px] text-[#555b65] transition hover:bg-[#f0efeb] hover:text-[#0c0e12]" aria-label="Meeting information">
            <InformationCircleIcon size={18} />
          </button>
        )}
        {onInvite && (
          <button type="button" onClick={onInvite} className="grid h-10 w-10 place-items-center rounded-[7px] border border-[#deddd7] bg-white transition hover:border-[#9f9f99] hover:bg-[#f7f6f2]" aria-label="Invite participants">
            <UserGroupIcon size={18} />
          </button>
        )}
        {onLayoutChange && (
          <div className="hidden gap-0.5 rounded-[9px] bg-[#f0efeb] p-1 sm:flex" role="group" aria-label="Video layout">
            <button
              type="button"
              onClick={() => onLayoutChange("focus")}
              className={cn("grid h-8 w-8 place-items-center rounded-[6px] text-[#6d727b] transition", layout === "focus" ? "bg-white text-[#202329] shadow-[0_1px_2px_rgba(12,14,18,0.08)]" : "hover:text-[#202329]")}
              aria-label="Spotlight layout"
              aria-pressed={layout === "focus"}
            >
              <Maximize01Icon size={15} />
            </button>
            <button
              type="button"
              onClick={() => onLayoutChange("grid")}
              className={cn("grid h-8 w-8 place-items-center rounded-[6px] text-[#6d727b] transition", layout === "grid" ? "bg-white text-[#202329] shadow-[0_1px_2px_rgba(12,14,18,0.08)]" : "hover:text-[#202329]")}
              aria-label="Grid layout"
              aria-pressed={layout === "grid"}
            >
              <LayoutGridIcon size={15} />
            </button>
            <button
              type="button"
              onClick={() => onLayoutChange("presentation")}
              className={cn("grid h-8 w-8 place-items-center rounded-[6px] text-[#6d727b] transition", layout === "presentation" ? "bg-white text-[#202329] shadow-[0_1px_2px_rgba(12,14,18,0.08)]" : "hover:text-[#202329]")}
              aria-label="Sidebar layout"
              aria-pressed={layout === "presentation"}
            >
              <ColumnIcon size={15} />
            </button>
          </div>
        )}
        {onSettings && (
          <button type="button" onClick={onSettings} className="grid h-10 w-10 place-items-center rounded-[7px] border border-[#deddd7] bg-white transition hover:border-[#9f9f99] hover:bg-[#f7f6f2]" aria-label="Settings">
            <Settings01Icon size={18} />
          </button>
        )}
      </div>
    </header>
  );
});

ConferenceHeader.displayName = "ConferenceHeader";
