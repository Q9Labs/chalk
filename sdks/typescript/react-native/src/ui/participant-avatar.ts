import type { ParticipantGradientPreference } from "./native-types";

export interface ParticipantColor {
  readonly primary: string;
  readonly gradientEnd: string;
  readonly surface: string;
}

/**
 * Muted identity colors from the Chalk design system. The second color is a
 * quiet tile wash; the identity itself always renders as a flat primary.
 */
export const PARTICIPANT_AVATAR_PALETTE = [
  { primary: "#315F72", surface: "#DCEBEF" },
  { primary: "#5C6650", surface: "#E3EADF" },
  { primary: "#6B5B4F", surface: "#ECE3DC" },
  { primary: "#64576B", surface: "#E8E0EA" },
  { primary: "#49645D", surface: "#DFEAE6" },
  { primary: "#665D42", surface: "#EBE6D6" },
  { primary: "#4D5D73", surface: "#E1E6EC" },
  { primary: "#6D5158", surface: "#EEE0E3" },
] as const;

export function getParticipantInitials(name?: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }

  const first = parts[0]?.[0] ?? "?";
  const second = parts[1]?.[0] ?? "";
  return `${first}${second}`.toUpperCase();
}

export function getParticipantColor(seed = "guest", _preference?: ParticipantGradientPreference): ParticipantColor {
  const palette = PARTICIPANT_AVATAR_PALETTE[hashString(seed) % PARTICIPANT_AVATAR_PALETTE.length] ?? PARTICIPANT_AVATAR_PALETTE[0];
  return {
    primary: palette.primary,
    // Kept for import/API compatibility. Gradient surfaces now use a single
    // primary stop, so this alias must never introduce a second color.
    gradientEnd: palette.primary,
    surface: palette.surface,
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
    // Facehash is no longer rendered by the native default avatar. Keep a
    // flat compatibility recipe for consumers that still read this field.
    facehashColors: [colors.primary, colors.primary, colors.primary],
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (const character of value.trim().toLowerCase() || "guest") {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
