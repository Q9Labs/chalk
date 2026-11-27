import React from "react";
import { cn } from "../../utils/cn";

export const AIBadge = React.memo(({ className }: { readonly className?: string }) => (
  <span aria-label="AI participant" title="AI participant" className={cn("inline-flex shrink-0 items-center rounded-full bg-[var(--chalk-accent)] px-(--space-1) py-(--space-0-5) text-(length:--type-caption) font-semibold leading-none text-[var(--chalk-accent-text)]", className)}>
    AI
  </span>
));

AIBadge.displayName = "AIBadge";
