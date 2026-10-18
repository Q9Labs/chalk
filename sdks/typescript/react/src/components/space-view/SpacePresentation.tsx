"use client";
import { useRef, type ReactNode } from "react";
import { useIdleChrome, useStageRefit } from "../../internal/call-motion";
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
  readonly toasts?: ReactNode;
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
export function SpacePresentation({ colorScheme = "dark", stageBackground, header, stage, controls, compactControls, stageOverlay, sidebar, mediaOutput, toasts, overlays, dialogs, renderToken, interactive = true, className }: SpacePresentationProps): React.JSX.Element {
  const root = useRef<HTMLElement>(null);
  const idle = useIdleChrome(root, interactive);
  useStageRefit(root);
  return (
    <main ref={root} data-chalk data-part="call-frame" data-idle={idle} data-chalk-theme={colorScheme} data-recording-space-render-token={renderToken} inert={interactive ? undefined : true} className={cn("chalk-root chalk-frame", className)}>
      {mediaOutput}
      <SpaceHeader {...header} className={cn("chalk-frame-header", header.className)} />
      <section data-part="stage-region" data-stage-background={stageBackground} className="chalk-frame-stage" aria-label="Space stage">
        <div data-part="stage-layout" className="chalk-stage-layout">
          {stage}
          {stageOverlay}
        </div>
      </section>
      <div data-part="dock-region" className="chalk-frame-dock">
        <div className={compactControls ? "chalk-frame-regular" : undefined}>{controls}</div>
        {compactControls ? <div className="chalk-frame-compact">{compactControls}</div> : null}
      </div>
      {sidebar}
      {toasts}
      <div data-part="overlays-region" className="chalk-frame-overlays">
        {overlays}
        {dialogs}
      </div>
    </main>
  );
}
