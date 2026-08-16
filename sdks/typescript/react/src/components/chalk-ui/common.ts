import type { CSSProperties } from "react";

export type ChalkTone = "neutral" | "accent" | "danger" | "success";
export type ChalkButtonVariant = "outline" | "solid" | "scribble" | "ghost";
export type ChalkSeed = number | string;

export const TONE_STROKES: Record<ChalkTone, string> = {
  neutral: "var(--chalk-line, var(--chalk-app-line-strong, currentColor))",
  accent: "var(--chalk-accent, var(--chalk-app-control-active-line, currentColor))",
  danger: "var(--chalk-danger, var(--chalk-app-danger))",
  success: "var(--chalk-positive, var(--chalk-app-success))",
};

export const TONE_FILLS: Record<ChalkTone, string> = {
  neutral: "var(--chalk-surface, var(--chalk-app-control, currentColor))",
  accent: "var(--chalk-accent, var(--chalk-app-control-primary, currentColor))",
  danger: "var(--chalk-danger-surface, var(--chalk-app-danger-surface))",
  success: "var(--chalk-positive, var(--chalk-app-control-primary))",
};

export function mergeStyle(style: CSSProperties | undefined, position: CSSProperties["position"] = "relative"): CSSProperties {
  return { position, ...style };
}
