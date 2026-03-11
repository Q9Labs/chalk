import React, { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { cn } from "../../utils/cn";
import { InformationCircleIcon, CheckmarkCircle02Icon, Alert02Icon, CancelCircleIcon } from "../../utils/icons";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";

export interface Notification {
  id: string;
  message: string;
  type?: "info" | "success" | "warning" | "error";
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface NotificationStackProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  maxVisible?: number;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

const positionMap = {
  "top-right": "top-right" as const,
  "top-left": "top-left" as const,
  "bottom-right": "bottom-right" as const,
  "bottom-left": "bottom-left" as const,
};

export const NotificationStack = React.memo<NotificationStackProps>(({ notifications, onDismiss, position = "top-right", maxVisible = 5, participantColorSeed, participantGradientPreference, className }) => {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document !== "undefined") {
      return document.documentElement.classList.contains("dark") ? "dark" : "light";
    }
    return "light";
  });
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);

  useEffect(() => {
    const handleThemeChange = () => {
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    };

    handleThemeChange();

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "class") {
          handleThemeChange();
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const activeIds = new Set<string>();

    notifications.slice(0, maxVisible).forEach((notification) => {
      if (activeIds.has(notification.id)) return;
      activeIds.add(notification.id);

      const toastOptions = {
        id: notification.id,
        duration: notification.duration ?? 5000,
        onDismiss: () => onDismiss(notification.id),
        action: notification.action
          ? {
              label: notification.action.label,
              onClick: notification.action.onClick,
            }
          : undefined,
      };

      switch (notification.type) {
        case "success":
          toast.success(notification.message, toastOptions);
          break;
        case "error":
          toast.error(notification.message, toastOptions);
          break;
        case "warning":
          toast.warning(notification.message, toastOptions);
          break;
        default:
          toast.info(notification.message, toastOptions);
      }
    });
  }, [notifications, maxVisible, onDismiss]);

  return (
    <Toaster
      theme={theme}
      position={positionMap[position]}
      visibleToasts={maxVisible}
      closeButton
      icons={{
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
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: cn(
            "group flex items-center gap-3 p-2 pr-3 rounded-xl shadow-2xl min-w-[280px] max-w-md",
            "bg-card border border-border text-foreground",
            "chalk-animate-toast-in",
          ),
          title: "text-sm font-semibold leading-none",
          description: "text-[11px] text-muted-foreground leading-tight",
          actionButton: "ml-auto px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-wider hover:opacity-90 transition-opacity",
          closeButton: "!static !transform-none !bg-transparent !border-none !p-1 !m-0 !text-muted-foreground hover:!text-foreground transition-colors",
        },
      }}
      className={cn(className)}
      style={themeVariables as React.CSSProperties}
    />
  );
});

NotificationStack.displayName = "NotificationStack";

export { toast };
