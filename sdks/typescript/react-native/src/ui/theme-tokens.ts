/**
 * The one default token set shared by the public Chalk theme and native styles.
 * Components consume semantic aliases from `Theme`, never raw color literals.
 */
export const DEFAULT_CHALK_THEME_TOKENS = {
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

/** Light-mode defaults for the same public token contract. */
export const LIGHT_CHALK_THEME_TOKENS: ChalkThemeTokenValues = {
  canvas: "#f8fafc",
  chrome: "#ffffff",
  surface: "#f1f5f9",
  stage: "#e2e8f0",
  text: "#0f172a",
  mutedText: "#475569",
  line: "#cbd5e1",
  accent: "#0f766e",
  accentText: "#ffffff",
  positive: "#15803d",
  danger: "#b91c1c",
  dangerSurface: "#fee2e2",
  focus: "#0f766e",
  shadow: "#0f172a",
};

export type ChalkThemeTokenName = keyof typeof DEFAULT_CHALK_THEME_TOKENS;
export type ChalkThemeTokenValues = Readonly<Record<ChalkThemeTokenName, string>>;
