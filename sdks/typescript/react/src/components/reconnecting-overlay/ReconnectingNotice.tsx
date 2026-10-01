import React from "react";
import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";

/** Slim top-of-Episode notice for short drops. It never intercepts pointer events or takes focus. */
export const ReconnectingNotice = React.memo<{ className?: string }>(({ className }) => {
  const skin = useSkin();
  return (
    <div data-chalk-skin={skin} className={cn("pointer-events-none absolute inset-x-0 top-14 z-50 flex justify-center px-4", className)}>
      <div
        role="status"
        aria-live="polite"
        data-testid="reconnecting-notice"
        className="pointer-events-none flex items-center gap-2 rounded-full border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] px-3 py-1.5 text-sm font-medium text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-[var(--chalk-app-control-primary)] motion-safe:animate-pulse" />
        Reconnecting…
      </div>
    </div>
  );
});

ReconnectingNotice.displayName = "ReconnectingNotice";
