import React, { useCallback, type CSSProperties, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome, ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";

export interface TileShellProps {
  /** Accessible name of the whole tile, e.g. "Video tile for Nora". */
  readonly label: string;
  /** Accent used for the pinned ring and the avatar voice halo, usually the participant colour. */
  readonly accentColor: string;
  readonly pinned?: boolean;
  readonly onClick?: () => void;
  readonly onDoubleClick?: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly dataTour?: string;
  /** Off-screen tiles stay mounted but leave the accessibility tree and tab order. */
  readonly hidden?: boolean;
  /** Lower-left chip: name plus status; omitted when null. Rendered inside a `min-w-0` flex row so a `truncate` name shrinks to the tile. */
  readonly chip?: ReactNode;
  /** Top-right slot (connection warning, pin marker). */
  readonly corner?: ReactNode;
  /** Media layer: video, avatar wash, board card. */
  readonly children?: ReactNode;
}

interface TileVars extends CSSProperties {
  "--chalk-participant-color": string;
  "--tw-ring-color"?: string;
}

/**
 * Shared tile chrome for participant and content tiles: frame, pinned ring, chip slot, chalk stroke.
 * The shell is a `@container`, so the chip picks its size from the tile width (`@[240px]:` variants).
 * Speaking is shown in the chip and on the avatar, never as a frame.
 */
export function TileShell({ label, accentColor, pinned = false, onClick, onDoubleClick, className, style, dataTour, hidden = false, chip, corner, children }: TileShellProps): React.JSX.Element {
  const skin = useSkin();
  const vars: TileVars = {
    ...style,
    "--chalk-participant-color": accentColor,
    ...(pinned ? { "--tw-ring-color": `${accentColor}80` } : {}),
  };
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!onClick || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      onClick();
    },
    [onClick],
  );

  return (
    <div
      className={cn(
        "@container relative overflow-hidden rounded-[8px] border border-transparent bg-[var(--chalk-app-tile-base)] outline-none",
        pinned && "ring-2",
        onClick && "cursor-pointer focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chalk-canvas)]",
        className,
      )}
      style={vars}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={handleKeyDown}
      data-tour={dataTour}
      role={onClick ? "button" : "region"}
      tabIndex={onClick && !hidden ? 0 : undefined}
      aria-hidden={hidden || undefined}
      aria-label={label}
    >
      {children}
      {corner}
      {chip ? (
        <div className="pointer-events-none absolute right-1.5 bottom-1.5 left-1.5 z-20 flex @[240px]:right-2 @[240px]:bottom-2 @[240px]:left-2">
          {skin === "classic" ? (
            <div className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-[rgba(12,14,18,0.62)] px-1.5 py-0.5 text-white shadow-[0_1px_2px_rgba(0,0,0,0.35)] ring-1 ring-white/10 backdrop-blur-md @[240px]:gap-2 @[240px]:px-2 @[240px]:py-1">{chip}</div>
          ) : (
            <ChalkPanel tone="neutral" filled className="inline-flex min-w-0 max-w-full items-center rounded-md" contentClassName="flex min-w-0 max-w-full items-center gap-1.5 px-1.5 py-0.5 @[240px]:gap-2 @[240px]:px-2 @[240px]:py-1">
              {chip}
            </ChalkPanel>
          )}
        </div>
      ) : null}
      <ChalkChrome className="pointer-events-none absolute inset-0 z-20 h-full w-full" focusStroke="var(--chalk-focus, var(--chalk-app-control-active-line, currentColor))" radius={8} roughness={0.9} stroke="var(--chalk-app-line-strong, currentColor)" part="participant-tile" />
    </div>
  );
}
