import React, { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { cn } from "../../utils/cn";
import { InformationCircleIcon, CheckmarkCircle02Icon, Alert02Icon, CancelCircleIcon } from "../../utils/icons";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { getThemeMode, type ThemePalette, type ThemeTexture } from "../theme";
import { ChalkAlert, ChalkBadge, ChalkButton, ChalkIconButton } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicToastStack } from "./ClassicToastStack";

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

const TOAST_TONES = {
  info: "accent",
  success: "success",
  warning: "neutral",
  error: "danger",
} as const;

function ToastContent({ currentToast, toastId }: { currentToast: Toast; toastId: string | number }) {
  const tone = TOAST_TONES[currentToast.type ?? "info"];
  const icon = currentToast.type === "success" ? <CheckmarkCircle02Icon size={18} /> : currentToast.type === "warning" ? <Alert02Icon size={18} /> : currentToast.type === "error" ? <CancelCircleIcon size={18} /> : <InformationCircleIcon size={18} />;

  return (
    <ChalkAlert tone={tone} className="group flex min-w-[300px] max-w-[360px] items-center gap-3 !rounded-[12px] !p-2.5 pr-3 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)] chalk-animate-toast-in">
      <ChalkBadge tone={tone} className="!h-9 !w-9 !shrink-0 !rounded-[8px] !p-0">
        {icon}
      </ChalkBadge>
      <div className="min-w-0 flex-1 text-sm font-medium leading-5">{currentToast.message}</div>
      {currentToast.action ? (
        <ChalkButton variant="solid" tone="accent" className="!min-h-8 !rounded-[7px] !px-2.5 !py-1.5 !text-[11px] !font-semibold !text-[var(--chalk-app-control-active-text)]" onClick={currentToast.action.onClick}>
          {currentToast.action.label}
        </ChalkButton>
      ) : null}
      <ChalkIconButton size="sm" aria-label="Dismiss notification" className="!size-8 !rounded-[7px] !border-0 !bg-transparent !p-1 !text-[var(--chalk-app-text-muted)] hover:!text-[var(--chalk-app-text)]" onClick={() => toast.dismiss(toastId)}>
        ×
      </ChalkIconButton>
    </ChalkAlert>
  );
}

export const ToastStack = React.memo<ToastStackProps>((props) => {
  const skin = useSkin();

  return skin === "classic" ? <ClassicToastStack {...props} /> : <ChalkToastStack {...props} />;
});

function ChalkToastStack({ toasts, onDismiss, position = "top-right", maxVisible = 5, participantColorSeed, participantGradientPreference, palette, texture = "none", className }: ToastStackProps) {
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
      };

      toast.custom((toastId) => <ToastContent currentToast={currentToast} toastId={toastId} />, {
        ...toastOptions,
        id: currentToast.id,
      });
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
      closeButton={false}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "!border-0 !bg-transparent !p-0 !shadow-none",
        },
      }}
      className={cn("chalk-root", className)}
      style={themeVariables as React.CSSProperties}
    />
  );
}

ToastStack.displayName = "ToastStack";

export { toast };
