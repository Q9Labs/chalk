import React from "react";
import { cn } from "../../utils/cn";
import { SparklesIcon } from "../../utils/icons";
import { ChalkBadge, ChalkIconButton } from "../chalk-ui";

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
    <ChalkIconButton onClick={onClick} aria-label="What's New" className={cn("text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]", className)} seed="whats-new-trigger" size={isSmall ? "sm" : "md"}>
      <SparklesIcon size={isSmall ? 18 : 20} />
      {hasUnseen ? <ChalkBadge aria-label="New updates available" className={cn("absolute", isSmall ? "top-1 right-1" : "top-1.5 right-1.5")} dot seed="whats-new-badge" tone="accent" /> : null}
    </ChalkIconButton>
  );
});

WhatsNewTrigger.displayName = "WhatsNewTrigger";
