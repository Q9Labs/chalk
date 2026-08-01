import React from "react";

import { ColumnIcon, LayoutGridIcon, Maximize01Icon, Settings01Icon, Shield01Icon, UserGroupIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { StatusBadge } from "../atomic/StatusBadge";

export interface MeetingHeaderProps {
  roomName: string;
  logoUrl?: string;
  duration?: number;
  isRecording?: boolean;
  isTranscribing?: boolean;
  layout?: "grid" | "spotlight" | "sidebar";
  onLayoutChange?: (layout: "grid" | "spotlight" | "sidebar") => void;
  onInvite?: () => void;
  onSettings?: () => void;
  className?: string;
}

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

export const MeetingHeader = React.memo<MeetingHeaderProps>(({ roomName, logoUrl, duration = 0, isRecording = false, isTranscribing = false, layout = "spotlight", onLayoutChange, onInvite, onSettings, className }) => {
  return (
    <header className={cn("flex h-[76px] shrink-0 items-center justify-between gap-4 border-b border-[#deddd7] bg-[#fbfaf7] px-4 text-[#0c0e12] sm:px-7 lg:px-8", className)} role="banner">
      <div className="flex min-w-0 items-center gap-4 sm:gap-6">
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
        <span className="hidden items-center gap-2 text-sm font-medium text-[#4f8c4a] md:flex">
          <Shield01Icon size={17} />
          Secure
        </span>
        {onInvite && (
          <button type="button" onClick={onInvite} className="grid h-10 w-10 place-items-center rounded-[7px] border border-[#deddd7] bg-white transition hover:border-[#9f9f99] hover:bg-[#f7f6f2]" aria-label="Invite participants">
            <UserGroupIcon size={18} />
          </button>
        )}
        {onLayoutChange && (
          <div className="hidden overflow-hidden rounded-[7px] border border-[#deddd7] bg-white sm:flex" role="group" aria-label="Video layout">
            <button type="button" onClick={() => onLayoutChange("spotlight")} className={cn("grid h-10 w-10 place-items-center transition", layout === "spotlight" ? "bg-[#eaf7fb]" : "hover:bg-[#f7f6f2]")} aria-label="Spotlight layout" aria-pressed={layout === "spotlight"}>
              <Maximize01Icon size={16} />
            </button>
            <button type="button" onClick={() => onLayoutChange("grid")} className={cn("grid h-10 w-10 place-items-center border-l border-[#deddd7] transition", layout === "grid" ? "bg-[#eaf7fb]" : "hover:bg-[#f7f6f2]")} aria-label="Grid layout" aria-pressed={layout === "grid"}>
              <LayoutGridIcon size={16} />
            </button>
            <button type="button" onClick={() => onLayoutChange("sidebar")} className={cn("grid h-10 w-10 place-items-center border-l border-[#deddd7] transition", layout === "sidebar" ? "bg-[#eaf7fb]" : "hover:bg-[#f7f6f2]")} aria-label="Sidebar layout" aria-pressed={layout === "sidebar"}>
              <ColumnIcon size={16} />
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

MeetingHeader.displayName = "MeetingHeader";
