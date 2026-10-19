import type React from "react";
export const LIGHT_CHALK_THEME_TOKENS = {
  canvas: "#f3f3f5",
  surface: "#ffffff",
  raised: "#ececf0",
  hover: "#e1e1e6",
  pressed: "#d3d3d9",
  tile: "#e2e2e7",
  popover: "#ffffff",
  line: "rgba(0,0,0,.09)",
  lineStrong: "rgba(0,0,0,.15)",
  text: "#18181b",
  textStrong: "#000",
  mutedText: "#5c5d65",
  softText: "#3d3e45",
  danger: "#d93a3f",
  dangerHover: "#e04b50",
  dangerPressed: "#c93d42",
  dangerText: "#bf272c",
  positive: "#2b8a3e",
  warning: "#8a6400",
  accent: "#1b70a0",
  wash: "rgba(0,0,0,.04)",
  washStrong: "rgba(0,0,0,.07)",
  chrome: "#f3f3f5",
  stage: "#f3f3f5",
  accentText: "#f3f3f5",
  dangerSurface: "#ececf0",
  focus: "#18181b",
  shadow: "0 12px 32px rgba(0,0,0,0.12)",
  overlay: "rgba(12,14,18,0.75)",
  overlayStrong: "rgba(12,14,18,0.82)",
  overlayHover: "rgba(40,42,48,0.95)",
  onOverlay: "#ffffff",
  overlayWarning: "#e2bd3a",
  overlayDanger: "#ff6b6b",
  scrim: "rgba(0,0,0,0.55)",
} as const;
export const DARK_CHALK_THEME_TOKENS = {
  canvas: "#0b0c0e",
  surface: "#151619",
  raised: "#1d1f23",
  hover: "#272a2f",
  pressed: "#30333a",
  line: "rgba(255,255,255,.08)",
  lineStrong: "rgba(255,255,255,.14)",
  text: "#ececee",
  mutedText: "#9a9ca3",
  danger: "#e5484d",
  dangerHover: "#ec5d61",
  dangerPressed: "#c93d42",
  dangerText: "#ff6b6b",
  positive: "#80b879",
  warning: "#d9b641",
  accent: "#55aac9",
  tile: "#151619",
  popover: "#1d1f23",
  textStrong: "#fff",
  softText: "#c4c6cc",
  wash: "rgba(255,255,255,.05)",
  washStrong: "rgba(255,255,255,.08)",
  chrome: "#0b0c0e",
  stage: "#0b0c0e",
  accentText: "#0b0c0e",
  dangerSurface: "#1d1f23",
  focus: "#ececee",
  shadow: "0 12px 32px rgba(0,0,0,0.5)",
  overlay: "rgba(12,14,18,0.75)",
  overlayStrong: "rgba(12,14,18,0.82)",
  overlayHover: "rgba(40,42,48,0.95)",
  onOverlay: "#ffffff",
  overlayWarning: "#e2bd3a",
  overlayDanger: "#ff6b6b",
  scrim: "rgba(0,0,0,0.55)",
} as const;
export const CHALK_THEME_TOKENS = DARK_CHALK_THEME_TOKENS;
export type ChalkThemeTokens = { readonly [Token in keyof typeof CHALK_THEME_TOKENS]: string };
export type ChalkColorScheme = "light" | "dark";
export type ChalkTheme = {
  readonly colorScheme?: ChalkColorScheme;
  readonly accent?: string;
  readonly tokens?: Partial<ChalkThemeTokens>;
};
export function chalkThemeStyle(theme?: ChalkTheme, colorScheme: ChalkColorScheme = theme?.colorScheme ?? "dark"): React.CSSProperties {
  const defaults = colorScheme === "dark" ? DARK_CHALK_THEME_TOKENS : LIGHT_CHALK_THEME_TOKENS;
  const tokens = { ...defaults, ...theme?.tokens, ...(theme?.accent ? { accent: theme.accent } : {}) };
  return Object.fromEntries(Object.entries(tokens).map(([token, value]) => [`--chalk-${token.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`, value]));
}
