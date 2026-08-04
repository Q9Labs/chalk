import React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { resolvePortalThemeFromDocument } from "../../utils/theme";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
}

export const Tooltip = React.memo(({ content, children, position = "top", delay = 200, className }: TooltipProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const portalTheme = resolvePortalThemeFromDocument();

  return (
    <BaseTooltip.Provider delay={delay}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger
          render={(props) => (
            <span {...props} className="inline-flex">
              {children}
            </span>
          )}
        />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={position} sideOffset={8}>
            <BaseTooltip.Popup
              data-chalk
              data-chalk-theme={portalTheme}
              className={cn("chalk-root", "z-[1000] whitespace-nowrap rounded-lg bg-[var(--chalk-surface)] px-3 py-1.5 text-xs font-medium text-[var(--chalk-text)] shadow-xl border border-[var(--chalk-line)]", !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-200", className)}
            >
              {content}
              <BaseTooltip.Arrow className="fill-[var(--chalk-surface)] [&>path]:stroke-[var(--chalk-line)]" />
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
});

Tooltip.displayName = "Tooltip";
