import React, { useRef } from "react";

import { InformationCircleIcon, Settings01Icon, UserGroupIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { StatusBadge } from "../atomic/StatusBadge";
import { ChalkControlGroup, ChalkDivider, ChalkIconButton } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicSpaceHeader } from "./ClassicSpaceHeader";
import { LayoutMenu } from "./LayoutMenu";

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

export const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

const ChalkSpaceHeader = React.memo<SpaceHeaderProps>(({ spaceName, logoUrl, duration = 0, isRecording = false, isTranscribing = false, layout = "focus", onLayoutChange, onInvite, onInfo, onSettings, className }) => {
  const menuHost = useRef<HTMLDivElement>(null);
  return (
    <header className={cn("relative flex h-14 shrink-0 items-center justify-between gap-3 px-3 text-[var(--chalk-app-text)] sm:px-5 lg:px-6", className)} role="banner">
      {/* Out-of-flow host for the layout menu so the popup inherits the header theme without joining the flex row. */}
      <div ref={menuHost} className="absolute top-0 left-0 h-0 w-0" />
      <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
        {logoUrl ? <img src={logoUrl} alt="Chalk" className="h-auto w-[84px] shrink-0 sm:w-[92px]" draggable={false} /> : <span className="shrink-0 text-lg font-bold tracking-tight">Chalk</span>}
        <ChalkDivider className="hidden h-5 w-5 shrink-0 rotate-90 sm:block" seed="space-header-divider" />
        <h1 className="truncate text-sm font-semibold">{spaceName}</h1>
        <span className="hidden font-mono text-[11px] tabular-nums text-[var(--chalk-app-text-muted)] sm:block" aria-label={`Episode duration ${formatDuration(duration)}`}>
          {formatDuration(duration)}
        </span>
      </div>

      <ChalkControlGroup className="shrink-0 gap-1.5 sm:gap-2">
        {isRecording && <StatusBadge status="recording" pulse />}
        {isTranscribing && <StatusBadge status="transcribing" />}
        {onInvite && (
          <ChalkIconButton aria-label="Invite participants" className="text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]" onClick={onInvite} seed="space-header-invite" size="sm">
            <UserGroupIcon size={17} />
          </ChalkIconButton>
        )}
        {onLayoutChange && <LayoutMenu layout={layout} onLayoutChange={onLayoutChange} container={menuHost} skin="chalk" />}
        {onInfo && (
          <ChalkIconButton aria-label="Space information" className="text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]" onClick={onInfo} seed="space-header-info" size="sm" title="Space information">
            <InformationCircleIcon size={17} />
          </ChalkIconButton>
        )}
        {onSettings && (
          <ChalkIconButton aria-label="Settings" className="text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]" onClick={onSettings} seed="space-header-settings" size="sm" title="Settings">
            <Settings01Icon size={17} />
          </ChalkIconButton>
        )}
      </ChalkControlGroup>
    </header>
  );
});

ChalkSpaceHeader.displayName = "ChalkSpaceHeader";

export const SpaceHeader = React.memo<SpaceHeaderProps>((props) => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicSpaceHeader {...props} /> : <ChalkSpaceHeader {...props} />;
});

SpaceHeader.displayName = "SpaceHeader";
