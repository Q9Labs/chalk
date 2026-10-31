import React, { type CSSProperties, type ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface TileShellProps {
  readonly label: string;
  readonly participantId?: string;
  readonly accentColor: string;
  readonly pinned?: boolean;
  /** The 2px ring that marks the person whose view this board follows. */
  readonly ring?: boolean;
  readonly speaking?: boolean;
  readonly audioLevel?: number;
  readonly lift?: boolean;
  readonly onClick?: () => void;
  readonly onDoubleClick?: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly dataTour?: string;
  readonly hidden?: boolean;
  readonly chip?: ReactNode;
  readonly corner?: ReactNode;
  readonly children?: ReactNode;
}
interface TileVars extends CSSProperties {
  "--chalk-participant-color": string;
  "--chalk-voice-level": number;
}

/** One shared frame and bottom-left name tag for camera, screen and board tiles. */
export function TileShell({ label, participantId, accentColor, pinned = false, ring = false, speaking = false, audioLevel = 0.5, lift = true, onClick, onDoubleClick, className, style, dataTour, hidden = false, chip, corner, children }: TileShellProps): React.JSX.Element {
  const vars: TileVars = { ...style, containerType: "size", "--chalk-participant-color": accentColor, "--chalk-voice-level": audioLevel };
  return (
    <div
      data-part="stage-tile"
      data-participant-id={participantId}
      className={cn(
        "group/tile relative overflow-clip rounded-[12px] bg-[var(--chalk-app-tile-base)] max-[640px]:rounded-[14px] motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-[ease-out]",
        onClick && lift && "min-[641px]:[@media(hover:hover)]:hover:-translate-y-0.5",
        className,
      )}
      style={vars}
      data-tour={dataTour}
      aria-hidden={hidden || undefined}
      onDoubleClick={onClick ? undefined : onDoubleClick}
      role="region"
      aria-label={onClick ? undefined : label}
    >
      {children}
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          tabIndex={hidden ? -1 : 0}
          aria-label={label}
          aria-pressed={pinned}
          className="absolute inset-0 z-20 rounded-[inherit] outline-none motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-[ease-out] hover:bg-[var(--chalk-on-overlay)]/[.045] active:bg-[var(--chalk-on-overlay)]/[.09] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--chalk-focus)]"
        />
      ) : null}
      <div
        aria-hidden="true"
        data-part="speaking-ring"
        className="pointer-events-none absolute inset-0 z-30 rounded-[inherit] motion-safe:transition-opacity motion-safe:duration-[90ms] motion-safe:ease-linear"
        style={{ opacity: speaking ? 0.3 + 0.7 * audioLevel : 0, boxShadow: "inset 0 0 0 3px color-mix(in srgb, var(--chalk-on-overlay) 90%, transparent), inset 0 0 0 4px var(--chalk-scrim)" }}
      />
      {ring ? <div aria-hidden="true" data-part="follow-ring" className="pointer-events-none absolute inset-0 z-30 rounded-[inherit] shadow-[inset_0_0_0_2px_var(--chalk-text)]" /> : null}
      {corner}
      {chip ? (
        <div data-part="tile-tag" className="pointer-events-none absolute bottom-2 left-2 z-30 flex h-6 max-w-[calc(100%_-_16px)] items-center gap-[5px] rounded-[6px] bg-[var(--chalk-overlay)] px-2 text-[12px] leading-[1.4] font-medium text-[var(--chalk-on-overlay)]">
          {chip}
        </div>
      ) : null}
    </div>
  );
}
