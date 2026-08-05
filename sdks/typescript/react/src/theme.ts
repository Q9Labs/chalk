import type React from "react";

/** The default light palette used when no color scheme is requested. */
export const LIGHT_CHALK_THEME_TOKENS = {
  canvas: "#f7f6f2",
  chrome: "#fbfaf7",
  surface: "#ffffff",
  stage: "#eeede8",
  text: "#0c0e12",
  mutedText: "#555b65",
  line: "#deddd7",
  accent: "#315f72",
  accentText: "#ffffff",
  positive: "#4f8c4a",
  danger: "#b94c4c",
  dangerSurface: "#fdf0f0",
  focus: "#74b7cf",
  shadow: "0 22px 54px rgba(12, 14, 18, 0.08)",
} as const;

/** The dark palette must be explicit because token values are scoped inline. */
export const DARK_CHALK_THEME_TOKENS = {
  canvas: "#0a0a0b",
  chrome: "#141418",
  surface: "#141418",
  stage: "#101314",
  text: "#fbffff",
  mutedText: "#71717a",
  line: "#1c1c1f",
  accent: "#1bb6a6",
  accentText: "#ffffff",
  positive: "#22c55e",
  danger: "#ef4444",
  dangerSurface: "#7f1d1d",
  focus: "#1bb6a6",
  shadow: "#000000",
} as const;

/** Backwards-compatible internal name for the light defaults. */
export const CHALK_THEME_TOKENS = LIGHT_CHALK_THEME_TOKENS;

export type ChalkThemeTokens = {
  readonly [Token in keyof typeof CHALK_THEME_TOKENS]: string;
};

export type ChalkColorScheme = "light" | "dark" | "system";

export type ChalkTheme = {
  readonly colorScheme?: ChalkColorScheme;
  readonly accent?: string;
  readonly tokens?: Partial<ChalkThemeTokens>;
};

export function chalkThemeStyle(theme?: ChalkTheme, colorScheme?: Exclude<ChalkColorScheme, "system">): React.CSSProperties {
  const resolvedColorScheme = colorScheme ?? (theme?.colorScheme === "dark" ? "dark" : "light");
  const defaults = resolvedColorScheme === "dark" ? DARK_CHALK_THEME_TOKENS : LIGHT_CHALK_THEME_TOKENS;
  const tokens = { ...defaults, ...theme?.tokens, ...(theme?.accent ? { accent: theme.accent, focus: theme.accent } : {}) };

  return Object.fromEntries(Object.entries(tokens).map(([token, value]) => [`--chalk-${toKebabCase(token)}`, value])) as React.CSSProperties;
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}
