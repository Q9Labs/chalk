interface ColorPalette {
  id: string;
  label: string;
  primary: string;
  secondary: string;
  gradientEnd: string;
  border: string;
}

export interface ParticipantGradientPreference {
  mode: "auto" | "custom";
  from?: string;
  to?: string;
}

const COLOR_PALETTES: readonly ColorPalette[] = [
  { id: "brand-teal", label: "Brand Teal", primary: "#1bb6a6", secondary: "#0a1f1c", gradientEnd: "#0d9488", border: "rgba(27, 182, 166, 0.3)" },
  { id: "deep-teal", label: "Deep Teal", primary: "#0d9488", secondary: "#0a1917", gradientEnd: "#115e59", border: "rgba(13, 148, 136, 0.3)" },
  { id: "cyan", label: "Cyan", primary: "#06b6d4", secondary: "#0a1a1f", gradientEnd: "#0891b2", border: "rgba(6, 182, 212, 0.3)" },
  { id: "emerald", label: "Emerald", primary: "#10b981", secondary: "#0a1f16", gradientEnd: "#059669", border: "rgba(16, 185, 129, 0.3)" },
  { id: "sky", label: "Sky", primary: "#0ea5e9", secondary: "#0a161f", gradientEnd: "#0284c7", border: "rgba(14, 165, 233, 0.3)" },
  { id: "blue", label: "Blue", primary: "#3b82f6", secondary: "#0a1429", gradientEnd: "#2563eb", border: "rgba(59, 130, 246, 0.3)" },
  { id: "indigo", label: "Indigo", primary: "#6366f1", secondary: "#0f0a29", gradientEnd: "#4f46e5", border: "rgba(99, 102, 241, 0.3)" },
  { id: "violet", label: "Violet", primary: "#8b5cf6", secondary: "#140a29", gradientEnd: "#7c3aed", border: "rgba(139, 92, 246, 0.3)" },
  { id: "mint", label: "Mint", primary: "#2dd4bf", secondary: "#0a1f1c", gradientEnd: "#14b8a6", border: "rgba(45, 212, 191, 0.3)" },
  { id: "green", label: "Green", primary: "#22c55e", secondary: "#0f1f10", gradientEnd: "#16a34a", border: "rgba(34, 197, 94, 0.3)" },
  { id: "rose", label: "Rose", primary: "#f43f5e", secondary: "#2a0b15", gradientEnd: "#e11d48", border: "rgba(244, 63, 94, 0.3)" },
  { id: "orange", label: "Orange", primary: "#f97316", secondary: "#2a1209", gradientEnd: "#ea580c", border: "rgba(249, 115, 22, 0.3)" },
  { id: "amber", label: "Amber", primary: "#f59e0b", secondary: "#2a1b07", gradientEnd: "#d97706", border: "rgba(245, 158, 11, 0.3)" },
  { id: "fuchsia", label: "Fuchsia", primary: "#d946ef", secondary: "#240a29", gradientEnd: "#c026d3", border: "rgba(217, 70, 239, 0.3)" },
  { id: "slate", label: "Slate", primary: "#64748b", secondary: "#0f172a", gradientEnd: "#475569", border: "rgba(100, 116, 139, 0.3)" },
] as const;

export const PARTICIPANT_GRADIENT_PRESETS = COLOR_PALETTES.map((palette) => ({
  id: palette.id,
  label: palette.label,
  from: palette.primary,
  to: palette.gradientEnd,
  border: palette.border,
}));

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    hash = (hash << 5) - hash + character;
    hash &= hash;
  }
  return Math.abs(hash);
}

function isHexColor(value: string | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function adjustHexColor(hexColor: string, amount: number): string {
  const normalized = hexColor.replace("#", "");
  const channels = [0, 2, 4].map((index) => clampChannel(Number.parseInt(normalized.slice(index, index + 2), 16) + amount));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function withAlpha(hexColor: string, alpha: number): string {
  const normalized = hexColor.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${clampChannel(alpha * 255) / 255})`;
}

function resolveCustomPalette(preference: ParticipantGradientPreference): ColorPalette | null {
  if (preference.mode !== "custom" || !isHexColor(preference.from) || !isHexColor(preference.to)) {
    return null;
  }

  return {
    id: "custom",
    label: "Custom",
    primary: preference.from,
    gradientEnd: preference.to,
    secondary: adjustHexColor(preference.to, -48),
    border: withAlpha(preference.from, 0.3),
  };
}

function resolveParticipantPalette(participantId?: string, preference?: ParticipantGradientPreference): ColorPalette {
  const customPalette = preference ? resolveCustomPalette(preference) : null;
  if (customPalette) {
    return customPalette;
  }

  if (!participantId) {
    return COLOR_PALETTES[0] as ColorPalette;
  }

  const index = hashString(participantId) % COLOR_PALETTES.length;
  return COLOR_PALETTES[index] as ColorPalette;
}

export function getParticipantColor(participantId?: string, preference?: ParticipantGradientPreference): ColorPalette {
  return resolveParticipantPalette(participantId, preference);
}

function getReadableTextColor(hexColor: string): string {
  const normalized = hexColor.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const linearize = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
  return luminance > 0.5 ? "#0f172a" : "#f8fafc";
}

export function getParticipantThemeVariables(participantId?: string, preference?: ParticipantGradientPreference) {
  const colors = getParticipantColor(participantId, preference);
  return {
    "--primary": colors.primary,
    "--primary-foreground": getReadableTextColor(colors.primary),
    "--ring": colors.primary,
  };
}

export function getParticipantAvatarGradient(participantId?: string, preference?: ParticipantGradientPreference): string {
  const colors = getParticipantColor(participantId, preference);
  return `linear-gradient(135deg, ${colors.primary} 0%, ${colors.gradientEnd} 100%)`;
}

export function getParticipantGradient(participantId?: string, preference?: ParticipantGradientPreference): string {
  const colors = getParticipantColor(participantId, preference);
  return `linear-gradient(180deg, ${colors.primary} 0%, ${colors.gradientEnd} 100%)`;
}

export function getParticipantBorder(participantId?: string, preference?: ParticipantGradientPreference): string {
  return getParticipantColor(participantId, preference).border;
}

export function getParticipantInitials(name?: string): string {
  const normalizedName = name?.trim();
  if (!normalizedName) {
    return "?";
  }

  const localPart = normalizedName.includes("@") ? (normalizedName.split("@")[0] ?? normalizedName) : normalizedName;
  const segments = localPart
    .split(/[\s._-]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (normalizedName.includes("@") && segments.length <= 1) {
    return localPart.slice(0, 2).toUpperCase() || "?";
  }

  if (segments.length === 0) {
    return localPart.slice(0, 2).toUpperCase() || "?";
  }

  return (
    segments
      .slice(0, 2)
      .map((segment) => segment[0] || "")
      .join("")
      .toUpperCase() || "?"
  );
}

export function getParticipantAvatarRecipe(participantId?: string, preference?: ParticipantGradientPreference) {
  const colors = getParticipantColor(participantId, preference);

  return {
    avatarGradient: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.gradientEnd} 100%)`,
    colors,
    darkerAvatarGradient: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.secondary} 100%)`,
    facehashColors: [colors.primary, colors.gradientEnd, colors.secondary] as const,
    gradientStops: [
      { color: colors.primary, offset: "0%" },
      { color: colors.gradientEnd, offset: "50%" },
      { color: colors.secondary, offset: "100%" },
    ] as const,
    initials: getParticipantInitials(participantId),
  };
}

export function getParticipantInitial(name?: string): string {
  const value = name?.trim();
  return (value?.charAt(0) || "C").toUpperCase();
}
