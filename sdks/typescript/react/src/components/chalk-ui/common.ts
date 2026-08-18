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

export const CLASSIC_SURFACE_CLASSES = "border border-[var(--chalk-app-line,var(--chalk-line))] bg-[var(--chalk-app-control,var(--chalk-surface))]";
export const CLASSIC_PANEL_CLASSES = "border border-[var(--chalk-app-line,var(--chalk-line))] bg-[var(--chalk-app-panel,var(--chalk-surface))]";
export const CLASSIC_FOCUS_CLASSES = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--chalk-app-canvas,var(--chalk-canvas))]";
export const CLASSIC_FOCUS_WITHIN_CLASSES =
  "focus-within:border-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-within:ring-2 focus-within:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-within:ring-offset-1 focus-within:ring-offset-[var(--chalk-app-canvas,var(--chalk-canvas))]";

type ClassicToneClasses = {
  readonly border: string;
  readonly text: string;
  readonly background: string;
  readonly solidBorder: string;
  readonly solidBackground: string;
  readonly solidText: string;
  readonly solidHover: string;
};

const CLASSIC_TONE_CLASSES: Record<ChalkTone, ClassicToneClasses> = {
  neutral: {
    border: "border-[var(--chalk-app-line-strong,var(--chalk-line))]",
    text: "text-[var(--chalk-app-text,var(--chalk-text))]",
    background: "bg-[var(--chalk-app-control,var(--chalk-surface))]",
    solidBorder: "border-[var(--chalk-app-control-primary,var(--chalk-accent))]",
    solidBackground: "bg-[var(--chalk-app-control-primary,var(--chalk-accent))]",
    solidText: "text-[var(--chalk-app-control-active-text,var(--chalk-accent-text))]",
    solidHover: "hover:bg-[var(--chalk-app-control-primary-hover,var(--chalk-accent))]",
  },
  accent: {
    border: "border-[var(--chalk-app-control-active-line,var(--chalk-focus))]",
    text: "text-[var(--chalk-app-control-active-line,var(--chalk-focus))]",
    background: "bg-[var(--chalk-app-control-active,var(--chalk-surface))]",
    solidBorder: "border-[var(--chalk-app-control-primary,var(--chalk-accent))]",
    solidBackground: "bg-[var(--chalk-app-control-primary,var(--chalk-accent))]",
    solidText: "text-[var(--chalk-app-control-active-text,var(--chalk-accent-text))]",
    solidHover: "hover:bg-[var(--chalk-app-control-primary-hover,var(--chalk-accent))]",
  },
  danger: {
    border: "border-[var(--chalk-app-danger,var(--chalk-danger))]",
    text: "text-[var(--chalk-app-danger,var(--chalk-danger))]",
    background: "bg-[var(--chalk-app-control,var(--chalk-surface))]",
    solidBorder: "border-[var(--chalk-app-danger,var(--chalk-danger))]",
    solidBackground: "bg-[var(--chalk-app-danger,var(--chalk-danger))]",
    solidText: "text-[var(--chalk-app-control-active-text,var(--chalk-accent-text))]",
    solidHover: "hover:bg-[var(--chalk-app-danger-hover,var(--chalk-danger))]",
  },
  success: {
    border: "border-[var(--chalk-app-success,var(--chalk-positive))]",
    text: "text-[var(--chalk-app-success,var(--chalk-positive))]",
    background: "bg-[var(--chalk-app-control,var(--chalk-surface))]",
    solidBorder: "border-[var(--chalk-app-success,var(--chalk-positive))]",
    solidBackground: "bg-[var(--chalk-app-success,var(--chalk-positive))]",
    solidText: "text-[var(--chalk-app-control-active-text,var(--chalk-accent-text))]",
    solidHover: "hover:bg-[var(--chalk-app-success,var(--chalk-positive))]",
  },
};

type ClassicButtonVariantClasses = Record<ChalkButtonVariant, string>;

function createClassicButtonClasses(toneClasses: ClassicToneClasses): ClassicButtonVariantClasses {
  return {
    outline: `border ${toneClasses.border} ${toneClasses.background} ${toneClasses.text} hover:bg-[var(--chalk-app-control-hover,var(--chalk-stage))]`,
    solid: `border ${toneClasses.solidBorder} ${toneClasses.solidBackground} ${toneClasses.solidText} ${toneClasses.solidHover}`,
    scribble: `border ${toneClasses.border} ${toneClasses.background} ${toneClasses.text} hover:bg-[var(--chalk-app-control-hover,var(--chalk-stage))]`,
    ghost: `border border-transparent bg-transparent ${toneClasses.text} hover:bg-[var(--chalk-app-control-hover,var(--chalk-stage))]`,
  };
}

const CLASSIC_BUTTON_CLASSES: Record<ChalkTone, ClassicButtonVariantClasses> = {
  neutral: createClassicButtonClasses(CLASSIC_TONE_CLASSES.neutral),
  accent: createClassicButtonClasses(CLASSIC_TONE_CLASSES.accent),
  danger: createClassicButtonClasses(CLASSIC_TONE_CLASSES.danger),
  success: createClassicButtonClasses(CLASSIC_TONE_CLASSES.success),
};

export function classicToneSurfaceClasses(tone: ChalkTone): string {
  const toneClasses = CLASSIC_TONE_CLASSES[tone];
  return `${toneClasses.border} ${toneClasses.background} ${toneClasses.text}`;
}

export function classicTonePanelClasses(tone: ChalkTone): string {
  const toneClasses = CLASSIC_TONE_CLASSES[tone];
  return `${toneClasses.border} ${toneClasses.text}`;
}

export function classicButtonClasses(variant: ChalkButtonVariant, tone: ChalkTone): string {
  return CLASSIC_BUTTON_CLASSES[tone][variant];
}

export function mergeStyle(style: CSSProperties | undefined, position: CSSProperties["position"] = "relative"): CSSProperties {
  return { position, ...style };
}
