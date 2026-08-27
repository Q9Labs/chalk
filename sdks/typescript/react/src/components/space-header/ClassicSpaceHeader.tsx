import React, { useRef } from "react";

import { InformationCircleIcon, Settings01Icon, UserGroupIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { StatusBadge } from "../atomic/StatusBadge";
import { LogoSource } from "../logo/LogoSource";
import { LayoutMenu } from "./LayoutMenu";
import { formatDuration, type SpaceHeaderProps } from "./space-header-contract";

const GHOST_BUTTON = "grid h-8 w-8 place-items-center rounded-full text-[var(--chalk-app-text-muted)] transition hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]";

export const ClassicSpaceHeader = React.memo<SpaceHeaderProps>(({ spaceName, logoUrl, duration = 0, isRecording = false, isTranscribing = false, layout = "focus", onLayoutChange, onInvite, onInfo, onSettings, className }) => {
  const menuHost = useRef<HTMLDivElement>(null);
  return (
    <header className={cn("relative flex h-14 shrink-0 items-center justify-between gap-3 px-3 text-[var(--chalk-app-text)] sm:px-5 lg:px-6", className)} role="banner">
      {/* Out-of-flow host for the layout menu so the popup inherits the header theme without joining the flex row. */}
      <div ref={menuHost} className="absolute top-0 left-0 h-0 w-0" />
      <div className="flex min-w-0 items-center gap-3">
        <LogoSource className="h-7 w-auto shrink-0" height={28} logoUrl={logoUrl} />
        <span className="hidden h-5 w-px bg-[var(--chalk-app-line)] sm:block" aria-hidden="true" />
        <h1 className="truncate text-sm font-semibold">{spaceName}</h1>
        <span className="hidden font-mono text-[11px] tabular-nums text-[var(--chalk-app-text-muted)] sm:block" aria-label={`Episode duration ${formatDuration(duration)}`}>
          {formatDuration(duration)}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        {isRecording && <StatusBadge status="recording" pulse />}
        {isTranscribing && <StatusBadge status="transcribing" />}
        {onInvite && (
          <button type="button" onClick={onInvite} className={GHOST_BUTTON} aria-label="Invite participants" title="Invite participants">
            <UserGroupIcon size={17} />
          </button>
        )}
        {onLayoutChange && <LayoutMenu layout={layout} onLayoutChange={onLayoutChange} container={menuHost} skin="classic" />}
        {onInfo && (
          <button type="button" onClick={onInfo} className={GHOST_BUTTON} aria-label="Space information" title="Space information">
            <InformationCircleIcon size={17} />
          </button>
        )}
        {onSettings && (
          <button type="button" onClick={onSettings} className={GHOST_BUTTON} aria-label="Settings" title="Settings">
            <Settings01Icon size={17} />
          </button>
        )}
      </div>
    </header>
  );
});

ClassicSpaceHeader.displayName = "ClassicSpaceHeader";
