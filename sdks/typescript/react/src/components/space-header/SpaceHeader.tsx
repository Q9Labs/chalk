import React, { useRef } from "react";
import { cn } from "../../utils/cn";
import { StatusBadge } from "../atomic/StatusBadge";
import { LayoutMenu } from "./LayoutMenu";
import { formatDuration, type SpaceHeaderProps } from "./space-header-contract";

export { formatDuration, type SpaceHeaderProps } from "./space-header-contract";

export const SpaceHeader = React.memo<SpaceHeaderProps>(({ spaceName, duration = 0, isRecording = false, isTranscribing = false, layout = "focus", onLayoutChange, className }) => {
  const menuHost = useRef<HTMLDivElement>(null);
  return (
    <header className={cn("relative flex h-14 shrink-0 items-center justify-between gap-3 px-3 text-[var(--chalk-app-text)] sm:px-5 lg:px-6", className)} role="banner">
      {/* Out-of-flow host for the layout menu so the popup inherits the header theme without joining the flex row. */}
      <div ref={menuHost} className="absolute top-0 left-0 h-0 w-0" />
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="truncate text-sm font-semibold">{spaceName}</h1>
        <span className="hidden font-mono text-[11px] tabular-nums text-[var(--chalk-app-text-muted)] sm:block" aria-label={`Episode duration ${formatDuration(duration)}`}>
          {formatDuration(duration)}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        {isRecording && <StatusBadge status="recording" pulse />}
        {isTranscribing && <StatusBadge status="transcribing" />}

        {onLayoutChange && <LayoutMenu layout={layout} onLayoutChange={onLayoutChange} container={menuHost} />}
      </div>
    </header>
  );
});

SpaceHeader.displayName = "SpaceHeader";
