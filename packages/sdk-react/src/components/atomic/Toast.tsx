import React, { useEffect } from "react";
import { InformationCircleIcon, CheckmarkCircle02Icon, Alert02Icon, CancelCircleIcon, Cancel01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";

export interface ToastProps {
  message: string;
  type?: "info" | "success" | "warning" | "error";
  duration?: number;
  onDismiss?: () => void;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export const Toast = React.memo<ToastProps>(({ message, type = "info", duration = 0, onDismiss, action, className }) => {
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (duration > 0 && onDismiss) {
      const timer = setTimeout(onDismiss, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onDismiss]);

  const icons = {
    info: <InformationCircleIcon size={20} className="text-primary" />,
    success: <CheckmarkCircle02Icon size={20} className="text-success" />,
    warning: <Alert02Icon size={20} className="text-warning" />,
    error: <CancelCircleIcon size={20} className="text-destructive" />,
  };

  const borderColors = {
    info: "border-l-primary",
    success: "border-l-success",
    warning: "border-l-warning",
    error: "border-l-destructive",
  };

  return (
    <div className={cn("flex items-start gap-3 p-4 rounded-md shadow-lg min-w-[300px] max-w-md", "bg-card border border-border border-l-4", !prefersReducedMotion && "chalk-animate-toast-in", borderColors[type], className)} role={type === "error" || type === "warning" ? "alert" : "status"}>
      <div className="flex-shrink-0 mt-0.5">{icons[type]}</div>
      <div className="flex-1">
        <p className="text-sm font-medium text-foreground">{message}</p>
        {action && (
          <button onClick={action.onClick} className="mt-2 text-sm font-semibold text-foreground hover:underline focus:outline-none">
            {action.label}
          </button>
        )}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
          <Cancel01Icon size={16} />
        </button>
      )}
    </div>
  );
});

Toast.displayName = "Toast";
