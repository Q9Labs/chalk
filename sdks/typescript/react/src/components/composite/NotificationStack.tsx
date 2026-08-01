import React, { useEffect, useMemo, useRef, useState } from "react";
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
  const activeIds = useRef(new Set<string>());
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
    notifications.slice(0, maxVisible).forEach((notification) => {
      if (activeIds.current.has(notification.id)) return;
      activeIds.current.add(notification.id);

      const toastOptions = {
        id: notification.id,
        duration: notification.duration ?? 5000,
        onDismiss: () => {
          activeIds.current.delete(notification.id);
          onDismiss(notification.id);
        },
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
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#e6f3f8] text-[#315f72]">
            <InformationCircleIcon size={18} />
          </div>
        ),
        success: (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#e8f1e4] text-[#49645d]">
            <CheckmarkCircle02Icon size={18} />
          </div>
        ),
        warning: (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#fdf2cf] text-[#9a7314]">
            <Alert02Icon size={18} />
          </div>
        ),
        error: (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#f8e4e4] text-[#9f3f3f]">
            <CancelCircleIcon size={18} />
          </div>
        ),
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: cn("group flex min-w-[300px] max-w-[360px] items-center gap-3 rounded-[12px] border border-[#c9c8c2] bg-[#fbfaf7] p-2.5 pr-3 text-[#0c0e12] shadow-[0_18px_48px_rgba(12,14,18,0.14)]", "chalk-animate-toast-in"),
          title: "text-sm font-medium leading-5",
          description: "text-[11px] text-muted-foreground leading-tight",
          actionButton: "ml-auto rounded-[7px] bg-[#202329] px-2.5 py-1.5 text-[11px] font-semibold !text-white transition hover:bg-[#343840]",
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
