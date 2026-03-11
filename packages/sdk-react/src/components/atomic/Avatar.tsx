import React, { useMemo } from "react";
import { cn } from "../../utils/cn";
import { getParticipantAvatarGradient, getParticipantColor, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { useMeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";
import { useMeetingRoomTheme } from "../full/meeting-room/useMeetingRoomTheme";

export interface AvatarProps {
  name: string;
  src?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
  status?: "online" | "away" | "busy" | "offline";
  className?: string;
  style?: React.CSSProperties;
  gradientPreference?: ParticipantGradientPreference;
}

const sizeMap = {
  xs: { size: 24, fontSize: "0.75rem" },
  sm: { size: 32, fontSize: "0.875rem" },
  md: { size: 48, fontSize: "1rem" },
  lg: { size: 64, fontSize: "1.5rem" },
  xl: { size: 96, fontSize: "2.25rem" },
  "2xl": { size: 120, fontSize: "2.75rem" },
};

const statusColorMap = {
  online: "var(--success)",
  away: "var(--warning)",
  busy: "var(--destructive)",
  offline: "var(--muted-foreground)",
};

export const Avatar = React.memo(({ name, src, size = "md", status, className, style, gradientPreference }: AvatarProps) => {
  const initials = useMemo(() => {
    if (!name || name.trim() === "") return "?";
    const cleanName = name.trim();
    const parts = cleanName.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    return (
      parts
        .slice(0, 2)
        .map((n) => n[0] || "")
        .join("")
        .toUpperCase() || "?"
    );
  }, [name]);

  const { settings } = useMeetingRoomSettings();
  const { isDarkMode } = useMeetingRoomTheme({ theme: settings.appearance.theme });
  const isDarkerGradient = settings.appearance.gradient === "darker" && isDarkMode;

  const participantColors = useMemo(() => getParticipantColor(name || "unknown", gradientPreference), [gradientPreference, name]);
  const gradient = useMemo(() => (isDarkerGradient ? `linear-gradient(135deg, ${participantColors.primary} 0%, ${participantColors.secondary} 100%)` : getParticipantAvatarGradient(name || "unknown", gradientPreference)), [gradientPreference, name, isDarkerGradient, participantColors]);
  const { size: pxSize, fontSize } = sizeMap[size];

  return (
    <div className={cn("relative inline-flex shrink-0 rounded-full", className)} style={{ width: pxSize, height: pxSize, ...style }} role="img" aria-label={`Avatar for ${name || "Unknown"}`}>
      {src ? (
        <img src={src} alt={name} className="h-full w-full rounded-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-full text-white font-medium" style={{ fontSize, background: gradient }}>
          {initials}
        </div>
      )}
      {status && (
        <span
          className="absolute bottom-0 right-0 block rounded-full ring-2 ring-background"
          style={{
            width: Math.max(8, pxSize / 4),
            height: Math.max(8, pxSize / 4),
            backgroundColor: statusColorMap[status],
          }}
        />
      )}
    </div>
  );
});

Avatar.displayName = "Avatar";
