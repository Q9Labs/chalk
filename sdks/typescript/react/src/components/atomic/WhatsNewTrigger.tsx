import React from "react";
import { cn } from "../../utils/cn";
import { SparklesIcon } from "../../utils/icons";

export interface WhatsNewTriggerProps {
  /** Whether there's unseen content */
  hasUnseen?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Additional class names */
  className?: string;
  /** Size variant */
  size?: "sm" | "md";
}

/**
 * Trigger button for What's New dialog with notification badge
 *
 * @example
 * ```tsx
 * const { hasSeen, open } = useWhatsNew();
 * <WhatsNewTrigger hasUnseen={!hasSeen} onClick={open} />
 * ```
 */
export const WhatsNewTrigger = React.memo<WhatsNewTriggerProps>(({ hasUnseen = false, onClick, className, size = "md" }) => {
  const isSmall = size === "sm";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("relative inline-flex items-center justify-center rounded-lg transition-colors", "text-muted-foreground hover:text-foreground hover:bg-accent", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", isSmall ? "h-8 w-8" : "h-10 w-10", className)}
      aria-label="What's New"
    >
      <SparklesIcon size={isSmall ? 18 : 20} />
      {hasUnseen && <span className={cn("absolute rounded-full bg-primary", isSmall ? "top-1 right-1 h-2 w-2" : "top-1.5 right-1.5 h-2.5 w-2.5")} aria-label="New updates available" />}
    </button>
  );
});

WhatsNewTrigger.displayName = "WhatsNewTrigger";
