import React, { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { cn } from "../../utils/cn";
import { InformationCircleIcon, CheckmarkCircle02Icon, Alert02Icon, CancelCircleIcon } from "../../utils/icons";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { getThemeMode, type ThemePalette, type ThemeTexture } from "../theme";

export interface Toast {
  id: string;
  message: string;
  type?: "info" | "success" | "warning" | "error";
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  maxVisible?: number;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  palette?: ThemePalette;
  texture?: ThemeTexture;
  className?: string;
}

const positionMap = {
  "top-right": "top-right" as const,
  "top-left": "top-left" as const,
  "bottom-right": "bottom-right" as const,
  "bottom-left": "bottom-left" as const,
};

export const ToastStack = React.memo<ToastStackProps>(({ toasts, onDismiss, position = "top-right", maxVisible = 5, participantColorSeed, participantGradientPreference, palette, texture = "none", className }) => {
  const activeIds = useRef(new Set<string>());
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document !== "undefined") {
      return document.documentElement.classList.contains("dark") ? "dark" : "light";
    }
    return "light";
  });
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);
  const resolvedTheme = palette ? getThemeMode(palette) : theme;

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
    toasts.slice(0, maxVisible).forEach((currentToast) => {
      if (activeIds.current.has(currentToast.id)) return;
      activeIds.current.add(currentToast.id);

      const toastOptions = {
        id: currentToast.id,
        duration: currentToast.duration ?? 5000,
        onDismiss: () => {
          activeIds.current.delete(currentToast.id);
          onDismiss(currentToast.id);
        },
        action: currentToast.action
          ? {
              label: currentToast.action.label,
              onClick: currentToast.action.onClick,
            }
          : undefined,
      };

      switch (currentToast.type) {
        case "success":
          toast.success(currentToast.message, toastOptions);
          break;
        case "error":
          toast.error(currentToast.message, toastOptions);
          break;
        case "warning":
          toast.warning(currentToast.message, toastOptions);
          break;
        default:
          toast.info(currentToast.message, toastOptions);
      }
    });
  }, [toasts, maxVisible, onDismiss]);

  return (
    <Toaster
      theme={resolvedTheme}
      data-chalk
      data-chalk-theme={resolvedTheme}
      data-chalk-palette={palette}
      data-chalk-texture={texture}
      position={positionMap[position]}
      visibleToasts={maxVisible}
      closeButton
      icons={{
        info: (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[var(--chalk-app-control-active)] text-[var(--chalk-app-control-active-text)]">
            <InformationCircleIcon size={18} />
          </div>
        ),
        success: (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[var(--chalk-app-control-active-line)]/20 text-[var(--chalk-app-control-active-text)]">
            <CheckmarkCircle02Icon size={18} />
          </div>
        ),
        warning: (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[var(--chalk-app-control-group)] text-[var(--chalk-app-text)]">
            <Alert02Icon size={18} />
          </div>
        ),
        error: (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[var(--chalk-app-danger)]/10 text-[var(--chalk-app-danger)]">
            <CancelCircleIcon size={18} />
          </div>
        ),
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: cn("chalk-textured-surface group flex min-w-[300px] max-w-[360px] items-center gap-3 rounded-[12px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] p-2.5 pr-3 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)]", "chalk-animate-toast-in"),
          title: "text-sm font-medium leading-5",
          description: "text-[11px] leading-tight text-[var(--chalk-app-text-muted)]",
          actionButton: "ml-auto rounded-[7px] bg-[var(--chalk-app-control-primary)] px-2.5 py-1.5 text-[11px] font-semibold !text-white transition hover:bg-[var(--chalk-app-control-primary-hover)]",
          closeButton: "!static !m-0 !transform-none !border-none !bg-transparent !p-1 !text-[var(--chalk-app-text-muted)] transition-colors hover:!text-[var(--chalk-app-text)]",
        },
      }}
      className={cn("chalk-root", className)}
      style={themeVariables as React.CSSProperties}
    />
  );
});

ToastStack.displayName = "ToastStack";

export { toast };
