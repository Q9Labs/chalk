import * as React from "react";

import { cn } from "./lib/utils";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: React.ReactNode;
  readonly size?: "sm" | "md" | "lg";
  readonly variant?: "default" | "ghost" | "outline";
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, size = "md", variant = "default", className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-md transition-colors",
        size === "sm" && "h-8 w-8 p-1.5",
        size === "md" && "h-10 w-10 p-2",
        size === "lg" && "h-12 w-12 p-3",
        variant === "default" && "bg-muted text-foreground hover:bg-accent",
        variant === "ghost" && "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        variant === "outline" && "border border-border bg-transparent text-foreground hover:bg-muted",
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});

IconButton.displayName = "IconButton";

export { IconButton };
