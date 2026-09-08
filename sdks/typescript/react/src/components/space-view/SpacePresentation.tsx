"use client";

import type { ReactNode } from "react";

import { cn } from "../../utils/cn";
import { ChalkPanel } from "../chalk-ui";
import { SpaceHeader, type SpaceHeaderProps } from "../space-header/SpaceHeader";
import { getThemeMode, type ThemePalette, type ThemeSkin, type ThemeTexture } from "../theme";

export interface SpacePresentationProps {
  readonly skin: ThemeSkin;
  readonly palette: ThemePalette;
  readonly texture: ThemeTexture;
  readonly stageBackground: boolean;
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
export function SpacePresentation({ skin, palette, texture, stageBackground, header, stage, controls, compactControls, stageOverlay, sidebar, mediaOutput, overlays, dialogs, renderToken, interactive = true, className }: SpacePresentationProps): React.JSX.Element {
  const stageSurface =
    skin === "classic" ? (
      <section className={cn("min-h-0 min-w-0 flex-1 overflow-hidden rounded-[10px]", stageBackground ? "chalk-textured-surface bg-[var(--chalk-app-stage)]" : "bg-transparent")} aria-label="Space stage">
        {stage}
      </section>
    ) : (
      <section className="min-h-0 min-w-0 flex-1 overflow-hidden" aria-label="Space stage">
        <ChalkPanel filled={stageBackground} className={cn("h-full min-h-0 rounded-none p-0", stageBackground ? "bg-[var(--chalk-app-stage)]" : "bg-transparent")} contentClassName="h-full min-h-0" seed="space-stage-shell">
          {stage}
        </ChalkPanel>
      </section>
    );

  return (
    <main
      data-chalk
      data-chalk-skin={skin}
      data-chalk-theme={getThemeMode(palette)}
      data-chalk-palette={palette}
      data-chalk-texture={texture}
      data-recording-space-render-token={renderToken}
      inert={interactive ? undefined : true}
      className={cn("chalk-root chalk-textured-surface relative h-full min-h-0 overflow-hidden bg-[var(--chalk-app-canvas)] text-[var(--chalk-app-text)]", className)}
    >
      <section className="chalk-textured-surface relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-chrome)]">
        {mediaOutput}
        <SpaceHeader {...header} className={cn("relative z-20", header.className)} />

        <div className="relative flex min-h-0 w-full flex-1 overflow-hidden">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pt-1 pb-[5.5rem] sm:px-4 md:pb-[7.5rem] lg:px-5">
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
