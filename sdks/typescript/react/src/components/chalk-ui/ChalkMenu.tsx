import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkMenuProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkMenu = forwardRef<HTMLDivElement, ChalkMenuProps>(function ChalkMenu({ children, className, seed, roughness, style, tone = "neutral", role = "menu", ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <div ref={ref} className={cn("group relative overflow-visible rounded-lg bg-transparent p-1 text-[var(--chalk-app-text)]", className)} role={role} style={{ position: "relative", ...style }} {...props}>
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} filled focusStroke={stroke} radius={8} roughness={roughness} seed={seed} stroke={stroke} />
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkMenu.displayName = "ChalkMenu";

export interface ChalkMenuItemProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly disabled?: boolean;
}

export const ChalkMenuItem = forwardRef<HTMLDivElement, ChalkMenuItemProps>(function ChalkMenuItem({ children, className, disabled = false, seed, roughness, style, tabIndex, tone = "neutral", ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <div
      ref={ref}
      aria-disabled={disabled || undefined}
      className={cn("group relative flex min-h-9 items-center rounded-md px-3 py-2 text-sm outline-none focus-visible:outline-none", disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer", className)}
      role="menuitem"
      style={{ position: "relative", ...style }}
      tabIndex={disabled ? -1 : (tabIndex ?? 0)}
      {...props}
    >
      <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} radius={6} roughness={roughness} seed={seed} stroke={stroke} />
      <span className="relative z-[1]">{children}</span>
    </div>
  );
});

ChalkMenuItem.displayName = "ChalkMenuItem";
