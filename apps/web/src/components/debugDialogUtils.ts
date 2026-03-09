import type React from "react";

type ParticipantPalette = {
  primary: string;
  gradientEnd: string;
};

const PARTICIPANT_PALETTES: readonly ParticipantPalette[] = [
  { primary: "#1bb6a6", gradientEnd: "#0d9488" },
  { primary: "#0d9488", gradientEnd: "#115e59" },
  { primary: "#06b6d4", gradientEnd: "#0891b2" },
  { primary: "#10b981", gradientEnd: "#059669" },
  { primary: "#0ea5e9", gradientEnd: "#0284c7" },
  { primary: "#3b82f6", gradientEnd: "#2563eb" },
  { primary: "#6366f1", gradientEnd: "#4f46e5" },
  { primary: "#8b5cf6", gradientEnd: "#7c3aed" },
  { primary: "#2dd4bf", gradientEnd: "#14b8a6" },
  { primary: "#22c55e", gradientEnd: "#16a34a" },
];

export interface BrowserSystemInfo {
  browser: string;
  os: string;
  screen: string;
  dpr: number;
  lang: string;
  timezone: string;
  online: boolean;
  userAgent: string;
}

function hashString(input: string): number {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    const charCode = input.charCodeAt(index);
    hash = (hash << 5) - hash + charCode;
    hash |= 0;
  }

  return Math.abs(hash);
}

function getReadableTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;

  const linearize = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

  const luminance =
    0.2126 * linearize(red) +
    0.7152 * linearize(green) +
    0.0722 * linearize(blue);

  return luminance > 0.5 ? "#0f172a" : "#f8fafc";
}

export function getParticipantSeed(options: {
  displayName?: string | null;
  participantId?: string | null;
  routeRoomId?: string | null;
}) {
  return options.displayName || options.participantId || options.routeRoomId || undefined;
}

export function getParticipantThemeVariables(participantSeed?: string): React.CSSProperties {
  const palette = ((participantSeed
    ? PARTICIPANT_PALETTES[hashString(participantSeed) % PARTICIPANT_PALETTES.length]
    : PARTICIPANT_PALETTES[0]) ?? PARTICIPANT_PALETTES[0]) as ParticipantPalette;
  const primary = palette.primary;

  return {
    "--primary": primary,
    "--primary-foreground": getReadableTextColor(primary),
    "--ring": primary,
    "--primary-gradient": `linear-gradient(135deg, ${primary} 0%, ${palette.gradientEnd} 100%)`,
  } as React.CSSProperties;
}

export function resolveParticipantId(...participantIds: Array<string | null | undefined>) {
  for (const participantId of participantIds) {
    if (participantId) {
      return participantId;
    }
  }

  return "N/A";
}

export function formatRemaining(ms: number | null) {
  if (ms === null) return "";

  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

export function getRouteRoomId(pathname: string) {
  const match = pathname.match(/^\/room\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function formatBuildTime(buildTime: string) {
  const builtAt = new Date(buildTime);

  if (Number.isNaN(builtAt.getTime())) {
    return buildTime;
  }

  return builtAt.toLocaleString();
}

export function getBrowserAndOs(): BrowserSystemInfo {
  if (typeof window === "undefined") {
    return {
      browser: "Unknown",
      os: "Unknown",
      screen: "Unknown",
      dpr: 1,
      lang: "Unknown",
      timezone: "Unknown",
      online: false,
      userAgent: "",
    };
  }

  const ua = navigator.userAgent;
  let browser = "Unknown";

  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Safari")) browser = "Safari";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Edge")) browser = "Edge";

  let os = "Unknown";

  if (ua.includes("Mac")) os = "macOS";
  else if (ua.includes("Win")) os = "Windows";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";

  return {
    browser,
    os,
    screen: `${window.screen.width}x${window.screen.height}`,
    dpr: window.devicePixelRatio,
    lang: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: navigator.onLine,
    userAgent: ua,
  };
}
