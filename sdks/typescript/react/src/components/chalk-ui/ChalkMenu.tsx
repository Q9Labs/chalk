import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_PANEL_CLASSES, type ChalkTone } from "./common";

export interface ChalkMenuProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
}

export const ChalkMenu = forwardRef<HTMLDivElement, ChalkMenuProps>(function ChalkMenu({ children, className, style, tone = "neutral", role = "menu", ...props }, ref) {
  return (
    <div ref={ref} className={cn(cn(CLASSIC_PANEL_CLASSES, "rounded-lg p-1 text-[var(--chalk-app-text,var(--chalk-text))] shadow-[var(--chalk-app-shadow-sm,var(--chalk-shadow))]"), className)} role={role} style={{ position: "relative", ...style }} {...props}>
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkMenu.displayName = "ChalkMenu";

export interface ChalkMenuItemProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;

  readonly disabled?: boolean;
}

export const ChalkMenuItem = forwardRef<HTMLDivElement, ChalkMenuItemProps>(function ChalkMenuItem({ children, className, disabled = false, style, tabIndex, tone = "neutral", ...props }, ref) {
  return (
    <div
      ref={ref}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex min-h-9 items-center rounded-md px-3 py-2 text-sm outline-none transition-colors hover:bg-[var(--chalk-app-control-hover,var(--chalk-stage))] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))]",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
      role="menuitem"
      style={{ position: "relative", ...style }}
      tabIndex={disabled ? -1 : (tabIndex ?? 0)}
      {...props}
    >
      <span className="relative z-[1]">{children}</span>
    </div>
  );
});

ChalkMenuItem.displayName = "ChalkMenuItem";
