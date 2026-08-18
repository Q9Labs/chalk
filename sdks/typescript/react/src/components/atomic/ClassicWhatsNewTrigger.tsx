import React from "react";
import { cn } from "../../utils/cn";
import { SparklesIcon } from "../../utils/icons";
import type { WhatsNewTriggerProps } from "./WhatsNewTrigger";

export const ClassicWhatsNewTrigger = React.memo<WhatsNewTriggerProps>(({ hasUnseen = false, onClick, className, size = "md" }) => {
  const isSmall = size === "sm";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex items-center justify-center rounded-lg transition-colors",
        "text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)] hover:bg-[var(--chalk-stage)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]",
        isSmall ? "h-8 w-8" : "h-10 w-10",
        className,
      )}
      aria-label="What's New"
    >
      <SparklesIcon size={isSmall ? 18 : 20} />
      {hasUnseen && <span className={cn("absolute rounded-full bg-[var(--chalk-accent)]", isSmall ? "top-1 right-1 h-2 w-2" : "top-1.5 right-1.5 h-2.5 w-2.5")} aria-label="New updates available" />}
    </button>
  );
});

ClassicWhatsNewTrigger.displayName = "ClassicWhatsNewTrigger";
