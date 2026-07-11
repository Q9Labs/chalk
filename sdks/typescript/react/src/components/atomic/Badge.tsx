import React from "react";
import { cn } from "../../utils/cn";

export interface BadgeProps {
  count?: number;
  max?: number;
  variant?: "default" | "primary" | "success" | "warning" | "danger";
  dot?: boolean;
  showZero?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export const Badge = React.memo<BadgeProps>(({ count, max = 99, variant = "default", dot = false, showZero = false, className, children }) => {
  const isHidden = !showZero && count === 0 && !dot;

  if (isHidden) {
    return <>{children}</>;
  }

  const variantClasses = {
    default: "bg-muted text-foreground",
    primary: "bg-primary text-primary-foreground",
    success: "bg-success text-white",
    warning: "bg-warning text-white",
    danger: "bg-destructive text-white",
  };

  const badgeContent = dot ? "" : count !== undefined && count > max ? `${max}+` : count;

  const badgeElement = (
    <span className={cn("inline-flex items-center justify-center rounded-full font-medium", variantClasses[variant], dot ? "w-2 h-2 p-0" : "px-2 min-w-[1.25rem] h-5 text-xs", children && "absolute -top-1 -right-1 translate-x-1/2 -translate-y-1/2 z-10", className)}>{badgeContent}</span>
  );

  if (!children) {
    return badgeElement;
  }

  return (
    <div className="relative inline-flex">
      {children}
      {badgeElement}
    </div>
  );
});

Badge.displayName = "Badge";
