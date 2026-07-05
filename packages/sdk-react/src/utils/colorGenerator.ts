import type React from "react";

export interface ParticipantGradientPreference {
  mode?: "auto" | "custom";
  from?: string;
  to?: string;
}

export interface ParticipantColorRecipe {
  primary: string;
  secondary: string;
  text: string;
  gradientEnd: string;
}

export const PARTICIPANT_GRADIENT_PRESETS = [
  { id: "aurora", label: "Aurora", from: "#0ea5e9", to: "#22c55e" },
  { id: "ember", label: "Ember", from: "#f97316", to: "#ef4444" },
  { id: "orchid", label: "Orchid", from: "#a855f7", to: "#ec4899" },
  { id: "cobalt", label: "Cobalt", from: "#2563eb", to: "#14b8a6" },
  { id: "gold", label: "Gold", from: "#eab308", to: "#f97316" },
  { id: "slate", label: "Slate", from: "#64748b", to: "#94a3b8" },
] as const;

const AUTO_PALETTE: readonly [string, string][] = [
  ["#0ea5e9", "#22c55e"],
  ["#f97316", "#ef4444"],
  ["#a855f7", "#ec4899"],
  ["#2563eb", "#14b8a6"],
  ["#eab308", "#f97316"],
  ["#06b6d4", "#6366f1"],
  ["#84cc16", "#14b8a6"],
  ["#f43f5e", "#8b5cf6"],
];

function hashIdentity(identity: string): number {
  let hash = 2166136261;
  for (const char of identity.trim().toLowerCase() || "chalk") {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resolveGradient(identity = "chalk", preference?: ParticipantGradientPreference): [string, string] {
  if (preference?.mode === "custom" && preference.from && preference.to) {
    return [preference.from, preference.to];
  }

  return AUTO_PALETTE[hashIdentity(identity) % AUTO_PALETTE.length] ?? ["#64748b", "#94a3b8"];
}

export function getParticipantInitial(name?: string): string {
  return (name?.trim()?.[0] ?? "?").toUpperCase();
}

export function getParticipantInitials(name?: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? getParticipantInitial(name);
  const second = parts[1]?.[0] ?? "";
  return (parts.length > 1 ? first + second : first).toUpperCase();
}

export function getParticipantColor(identity = "chalk", preference?: ParticipantGradientPreference): ParticipantColorRecipe {
  const [primary, secondary] = resolveGradient(identity, preference);
  return {
    primary,
    secondary,
    text: "#ffffff",
    gradientEnd: secondary,
  };
}

export function getParticipantGradient(identity = "chalk", preference?: ParticipantGradientPreference): string {
  const [primary, secondary] = resolveGradient(identity, preference);
  return `linear-gradient(135deg, ${primary}, ${secondary})`;
}

export function getParticipantAvatarGradient(identity = "chalk", preference?: ParticipantGradientPreference): string {
  return getParticipantGradient(identity, preference);
}

export function getParticipantBorder(identity = "chalk", preference?: ParticipantGradientPreference): string {
  return getParticipantColor(identity, preference).primary;
}

export function getParticipantThemeVariables(identity = "chalk", preference?: ParticipantGradientPreference): React.CSSProperties {
  const colors = getParticipantColor(identity, preference);
  return {
    "--primary": colors.primary,
    "--ring": colors.primary,
    "--chalk-accent": colors.primary,
    "--chalk-accent-2": colors.secondary,
  } as React.CSSProperties;
}

export function getParticipantAvatarRecipe(identity = "chalk", preference?: ParticipantGradientPreference) {
  const colors = getParticipantColor(identity, preference);
  const avatarGradient = getParticipantGradient(identity, preference);

  return {
    initials: getParticipantInitials(identity),
    gradient: avatarGradient,
    avatarGradient,
    darkerAvatarGradient: `linear-gradient(135deg, ${colors.primary}, #111827)`,
    color: colors.primary,
    border: colors.primary,
    facehashColors: [colors.primary, colors.secondary, "#f8fafc"],
  };
}
