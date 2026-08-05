import type { ParticipantGradientPreference } from "./native-types";
import { Theme } from "./theme";

const palettes = Theme.avatarPalettes;

export interface ParticipantColor {
  readonly primary: string;
  readonly gradientEnd: string;
  readonly surface: string;
}

export const PARTICIPANT_AVATAR_PALETTE = palettes.map(([primary, , surface]) => ({ primary, surface })) as readonly { readonly primary: string; readonly surface: string }[];

export function getParticipantInitials(name?: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return `${parts[0]?.[0] ?? "?"}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

export function getParticipantColor(seed = "guest", _preference?: ParticipantGradientPreference): ParticipantColor {
  const palette = palettes[hashString(seed) % palettes.length] ?? palettes[0];
  return {
    primary: palette[0],
    gradientEnd: palette[0],
    surface: palette[2],
  };
}

export function getParticipantAvatarRecipe(seed = "guest", preference?: ParticipantGradientPreference) {
  const colors = getParticipantColor(seed, preference);
  return {
    colors,
    gradientStops: [
      { color: colors.primary, offset: "0%" },
      { color: colors.primary, offset: "100%" },
    ],
    facehashColors: [colors.primary, colors.primary, colors.primary],
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
