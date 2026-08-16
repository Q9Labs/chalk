import React from "react";

import { InformationCircleIcon, LayoutGridIcon, Maximize01Icon, Monitor01Icon, Settings01Icon, UserGroupIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { StatusBadge } from "../atomic/StatusBadge";
import { ChalkControlGroup, ChalkDivider, ChalkIconButton, ChalkPanel } from "../chalk-ui";

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
    <header className={cn("relative flex h-[76px] shrink-0 items-center text-[var(--chalk-app-text)]", className)} role="banner">
      <ChalkPanel className="h-full w-full rounded-none p-0" seed="space-header-shell">
        <div className="flex h-full items-center justify-between gap-4 px-4 sm:px-7 lg:px-8">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            {logoUrl ? <img src={logoUrl} alt="Chalk" className="h-auto w-[108px] shrink-0 sm:w-[122px]" draggable={false} /> : <span className="shrink-0 text-xl font-bold tracking-tight">Chalk</span>}
            <ChalkDivider className="hidden h-7 w-7 shrink-0 rotate-90 sm:block" seed="space-header-divider" />
            <h1 className="truncate text-sm font-semibold sm:text-base">{spaceName}</h1>
            <span className="hidden font-mono text-xs tabular-nums text-[var(--chalk-app-text-muted)] sm:block" aria-label={`Space duration ${formatDuration(duration)}`}>
              {formatDuration(duration)}
            </span>
          </div>

          <ChalkControlGroup className="shrink-0 gap-2 sm:gap-3">
            {isRecording && <StatusBadge status="recording" pulse />}
            {isTranscribing && <StatusBadge status="transcribing" />}
            {onInfo && (
              <ChalkIconButton aria-label="Space information" className="text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]" onClick={onInfo} seed="space-header-info" size="sm">
                <InformationCircleIcon size={18} />
              </ChalkIconButton>
            )}
            {onInvite && (
              <ChalkIconButton aria-label="Invite participants" onClick={onInvite} seed="space-header-invite" size="md">
                <UserGroupIcon size={18} />
              </ChalkIconButton>
            )}
            {onLayoutChange && (
              <ChalkPanel className="hidden rounded-none p-1 sm:block" seed="space-header-layout-shell">
                <ChalkControlGroup aria-label="Video layout" className="gap-1" role="group">
                  <ChalkIconButton
                    aria-label="Spotlight layout"
                    aria-pressed={layout === "focus"}
                    className={cn("text-[var(--chalk-app-text-muted)]", layout === "focus" && "text-[var(--chalk-app-text)]")}
                    onClick={() => onLayoutChange("focus")}
                    seed="space-header-layout-focus"
                    size="sm"
                    tone={layout === "focus" ? "accent" : "neutral"}
                  >
                    <Maximize01Icon size={15} />
                  </ChalkIconButton>
                  <ChalkIconButton
                    aria-label="Grid layout"
                    aria-pressed={layout === "grid"}
                    className={cn("text-[var(--chalk-app-text-muted)]", layout === "grid" && "text-[var(--chalk-app-text)]")}
                    onClick={() => onLayoutChange("grid")}
                    seed="space-header-layout-grid"
                    size="sm"
                    tone={layout === "grid" ? "accent" : "neutral"}
                  >
                    <LayoutGridIcon size={15} />
                  </ChalkIconButton>
                  <ChalkIconButton
                    aria-label="Presentation layout"
                    aria-pressed={layout === "presentation"}
                    className={cn("text-[var(--chalk-app-text-muted)]", layout === "presentation" && "text-[var(--chalk-app-text)]")}
                    onClick={() => onLayoutChange("presentation")}
                    seed="space-header-layout-presentation"
                    size="sm"
                    tone={layout === "presentation" ? "accent" : "neutral"}
                  >
                    <Monitor01Icon size={15} />
                  </ChalkIconButton>
                </ChalkControlGroup>
              </ChalkPanel>
            )}
            {onSettings && (
              <ChalkIconButton aria-label="Settings" onClick={onSettings} seed="space-header-settings" size="md">
                <Settings01Icon size={18} />
              </ChalkIconButton>
            )}
          </ChalkControlGroup>
        </div>
      </ChalkPanel>
    </header>
  );
});

SpaceHeader.displayName = "SpaceHeader";
