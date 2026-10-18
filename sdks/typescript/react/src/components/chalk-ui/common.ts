import type { CSSProperties } from "react";

export type ChalkTone = "neutral" | "accent" | "danger" | "success";
export type ChalkButtonVariant = "outline" | "solid" | "ghost";

export const CLASSIC_SURFACE_CLASSES = "border border-[var(--chalk-app-line,var(--chalk-line))] bg-[var(--chalk-app-control,var(--chalk-surface))]";
export const CLASSIC_PANEL_CLASSES = "border border-[var(--chalk-app-line,var(--chalk-line))] bg-[var(--chalk-app-panel,var(--chalk-surface))]";
export const CLASSIC_FOCUS_CLASSES = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--chalk-app-canvas,var(--chalk-canvas))]";
export const CLASSIC_FOCUS_WITHIN_CLASSES =
  "focus-within:border-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-within:ring-2 focus-within:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-within:ring-offset-1 focus-within:ring-offset-[var(--chalk-app-canvas,var(--chalk-canvas))]";

type ToneClasses = {
  readonly border: string;
  readonly text: string;
  readonly background: string;
};

const CLASSIC_TONE_CLASSES: Record<ChalkTone, ToneClasses> = {
  neutral: {
    border: "border-[var(--chalk-app-line-strong,var(--chalk-line))]",
    text: "text-[var(--chalk-app-text,var(--chalk-text))]",
    background: "bg-[var(--chalk-app-control,var(--chalk-surface))]",
  },
  accent: {
    border: "border-[var(--chalk-app-control-active-line,var(--chalk-focus))]",
    text: "text-[var(--chalk-app-control-active-line,var(--chalk-focus))]",
    background: "bg-[var(--chalk-app-control-active,var(--chalk-surface))]",
  },
  danger: {
    border: "border-[var(--chalk-app-danger,var(--chalk-danger))]",
    text: "text-[var(--chalk-app-danger,var(--chalk-danger))]",
    background: "bg-[var(--chalk-app-control,var(--chalk-surface))]",
  },
  success: {
    border: "border-[var(--chalk-app-success,var(--chalk-positive))]",
    text: "text-[var(--chalk-app-success,var(--chalk-positive))]",
    background: "bg-[var(--chalk-app-control,var(--chalk-surface))]",
  },
};

export function classicToneSurfaceClasses(tone: ChalkTone): string {
  const toneClasses = CLASSIC_TONE_CLASSES[tone];
  return `${toneClasses.border} ${toneClasses.background} ${toneClasses.text}`;
}

export function classicTonePanelClasses(tone: ChalkTone): string {
  const toneClasses = CLASSIC_TONE_CLASSES[tone];
  return `${toneClasses.border} ${toneClasses.text}`;
}

export function mergeStyle(style: CSSProperties | undefined, position: CSSProperties["position"] = "relative"): CSSProperties {
  return { position, ...style };
}
