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
    info: (
      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary shrink-0">
        <InformationCircleIcon size={18} />
      </div>
    ),
    success: (
      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-success/10 text-success shrink-0">
        <CheckmarkCircle02Icon size={18} />
      </div>
    ),
    warning: (
      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-warning/10 text-warning shrink-0">
        <Alert02Icon size={18} />
      </div>
    ),
    error: (
      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-destructive/10 text-destructive shrink-0">
        <CancelCircleIcon size={18} />
      </div>
    ),
  };

  return (
    <div className={cn("flex items-center gap-3 p-2 pr-3 rounded-xl shadow-2xl min-w-[280px] max-w-md", "bg-card border border-border text-foreground", !prefersReducedMotion && "chalk-animate-toast-in", className)} role={type === "error" || type === "warning" ? "alert" : "status"}>
      <div className="flex-shrink-0">{icons[type]}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground leading-none">{message}</p>
        {action && (
          <button onClick={action.onClick} className="mt-2 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-wider hover:opacity-90 transition-opacity">
            {action.label}
          </button>
        )}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="flex-shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
          <Cancel01Icon size={16} />
        </button>
      )}
    </div>
  );
});

Toast.displayName = "Toast";
