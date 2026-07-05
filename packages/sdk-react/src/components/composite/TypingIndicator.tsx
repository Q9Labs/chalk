import React from "react";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";

export interface TypingIndicatorProps {
  typingUsers: string[];
  className?: string;
}

export const TypingIndicator = React.memo<TypingIndicatorProps>(({ typingUsers, className }) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  if (typingUsers.length === 0) return null;

  let text = "";
  if (typingUsers.length === 1) {
    text = `${typingUsers[0]} is typing`;
  } else if (typingUsers.length === 2) {
    text = `${typingUsers[0]} and ${typingUsers[1]} are typing`;
  } else if (typingUsers.length === 3) {
    text = `${typingUsers[0]}, ${typingUsers[1]}, and ${typingUsers[2]} are typing`;
  } else {
    text = `${typingUsers.length} people are typing`;
  }

  return (
    <div className={cn("flex items-center gap-2 text-xs text-muted-foreground p-2 h-6", className)} role="status">
      <span className="font-medium">{text}</span>
      <div className="flex gap-1">
        <div className={cn("w-1 h-1 bg-muted-foreground rounded-full", !prefersReducedMotion && "animate-bounce")} style={{ animationDelay: "0ms" }} />
        <div className={cn("w-1 h-1 bg-muted-foreground rounded-full", !prefersReducedMotion && "animate-bounce")} style={{ animationDelay: "150ms" }} />
        <div className={cn("w-1 h-1 bg-muted-foreground rounded-full", !prefersReducedMotion && "animate-bounce")} style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  );
});

TypingIndicator.displayName = "TypingIndicator";
