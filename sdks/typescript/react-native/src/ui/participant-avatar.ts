import type { ParticipantGradientPreference } from "./native-types";

const palettes = [
  ["#14b8a6", "#0f766e", "#99f6e4"],
  ["#f59e0b", "#b45309", "#fde68a"],
  ["#ec4899", "#be185d", "#fbcfe8"],
  ["#8b5cf6", "#6d28d9", "#ddd6fe"],
  ["#06b6d4", "#0e7490", "#cffafe"],
  ["#22c55e", "#15803d", "#bbf7d0"],
] as const;

export function getParticipantColor(seed = "guest", _preference?: ParticipantGradientPreference) {
  const palette = palettes[hashString(seed) % palettes.length] ?? palettes[0];
  return {
    primary: palette[0],
    gradientEnd: palette[1],
    surface: palette[2],
  };
}

export function getParticipantAvatarRecipe(seed = "guest", preference?: ParticipantGradientPreference) {
  const colors = getParticipantColor(seed, preference);
  return {
    colors,
    gradientStops: [
      { color: colors.primary, offset: "0%" },
      { color: colors.gradientEnd, offset: "100%" },
    ],
    facehashColors: [colors.primary, colors.gradientEnd, colors.surface],
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
