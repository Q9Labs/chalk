import type { ParticipantGradientPreference } from "./native-types";
import { Theme } from "./theme";

const palettes = Theme.avatarPalettes;

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
