"use client";
import type { ReactNode } from "react";
import { cn } from "../../utils/cn";
import { SpaceHeader, type SpaceHeaderProps } from "../space-header/SpaceHeader";
export interface SpacePresentationProps {
  readonly stageBackground: boolean;
  readonly colorScheme?: "light" | "dark";
  readonly header: SpaceHeaderProps;
  readonly stage: ReactNode;
  readonly controls: ReactNode;
  readonly compactControls?: ReactNode;
  readonly stageOverlay?: ReactNode;
  readonly sidebar?: ReactNode;
  readonly mediaOutput?: ReactNode;
  readonly overlays?: ReactNode;
  readonly dialogs?: ReactNode;
  readonly renderToken?: string;
  readonly interactive?: boolean;
  readonly className?: string;
}
/**
 * Presentation-only Space chrome shared by the live controller and deterministic
 * Recording projection. Networking, device effects and commands stay in callers.
 */
export function SpacePresentation({ colorScheme = "light", stageBackground, header, stage, controls, compactControls, stageOverlay, sidebar, mediaOutput, overlays, dialogs, renderToken, interactive = true, className }: SpacePresentationProps): React.JSX.Element {
  const stageSurface = (
    <section className={cn("min-h-0 min-w-0 flex-1 overflow-hidden rounded-[10px]", stageBackground ? "bg-[var(--chalk-app-stage)]" : "bg-transparent")} aria-label="Space stage">
      {stage}
    </section>
  );
  return (
    <main data-chalk data-chalk-theme={colorScheme} data-recording-space-render-token={renderToken} inert={interactive ? undefined : true} className={cn("chalk-root relative h-full min-h-0 overflow-hidden bg-[var(--chalk-app-canvas)] text-[var(--chalk-app-text)]", className)}>
      <section className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-chrome)]">
        {mediaOutput}
        <SpaceHeader {...header} className={cn("relative z-20", header.className)} />

        <div className="relative flex min-h-0 w-full flex-1 overflow-hidden">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pt-1 pb-[9rem] sm:px-4 md:pb-[7.5rem] lg:px-5">
            {stageSurface}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              <div className={cn("pointer-events-auto", compactControls ? "hidden md:block" : "block")}>{controls}</div>
              {compactControls ? <div className="pointer-events-auto md:hidden">{compactControls}</div> : null}
            </div>
            {stageOverlay}
          </div>

          {sidebar}
        </div>

        {overlays}
        {dialogs}
      </section>
    </main>
  );
}
