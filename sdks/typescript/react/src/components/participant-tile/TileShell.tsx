import React, { type CSSProperties, type ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface TileShellProps {
  readonly label: string;
  readonly accentColor: string;
  readonly pinned?: boolean;
  readonly speaking?: boolean;
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
}

/** One shared frame and bottom-left name tag for camera, screen and board tiles. */
export function TileShell({ label, accentColor, pinned = false, speaking = false, lift = true, onClick, onDoubleClick, className, style, dataTour, hidden = false, chip, corner, children }: TileShellProps): React.JSX.Element {
  const vars: TileVars = { ...style, containerType: "size", "--chalk-participant-color": accentColor };
  return (
    <div
      data-part="stage-tile"
      className={cn("group/tile relative overflow-clip rounded-[12px] bg-[var(--chalk-app-tile-base)] max-[640px]:rounded-[14px] motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out", onClick && lift && "[@media(hover:hover)]:hover:-translate-y-0.5", className)}
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
          className="absolute inset-0 z-20 rounded-[inherit] outline-none hover:bg-white/[.045] active:bg-white/[.09] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--chalk-focus)]"
        />
      ) : null}
      <div
        aria-hidden="true"
        data-part="speaking-ring"
        className="pointer-events-none absolute inset-0 z-30 rounded-[inherit] motion-safe:transition-opacity motion-safe:duration-[90ms] motion-safe:ease-linear"
        style={{ opacity: speaking ? 1 : 0, boxShadow: "inset 0 0 0 3px rgba(255,255,255,.9), inset 0 0 0 4px rgba(0,0,0,.35)" }}
      />
      {corner}
      {chip ? (
        <div data-part="tile-tag" className="pointer-events-none absolute bottom-2 left-2 z-30 flex h-6 max-w-[calc(100%_-_16px)] items-center gap-[5px] rounded-[6px] bg-[rgba(12,14,18,.75)] px-2 text-[12px] leading-[1.4] font-medium text-white">
          {chip}
        </div>
      ) : null}
    </div>
  );
}
