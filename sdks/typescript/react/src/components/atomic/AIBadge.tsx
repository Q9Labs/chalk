import React from "react";
import { cn } from "../../utils/cn";

/** The sparkle that marks an admitted AI participant after its name, in the surrounding text colour. */
export const AIBadge = React.memo(({ className }: { readonly className?: string }) => (
  <span role="img" aria-label="AI participant" title="AI participant" className={cn("inline-flex shrink-0 items-center", className)}>
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L10.5 13l1.5-.5z" />
    </svg>
  </span>
));

AIBadge.displayName = "AIBadge";
