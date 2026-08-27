import { THEME_PALETTES, THEME_SKINS, THEME_TEXTURES } from "../../../../../sdks/typescript/react/src/components/theme";

import type { PreviewFeatureKey, PreviewSearch, PreviewState } from "./preview-state";

const CUSTOM_LABELS: Record<string, string> = {
  people: "Participants",
  participants: "Participants",
  screenshare: "Screen share",
  screenShare: "Screen share",
  "soft-grid": "Soft grid",
  "soft-dots": "Soft dots",
  "start-camera": "Start camera",
  start_camera: "Start camera",
  handRaise: "Hand raise",
  none: "None",
};

const CAMEL_BOUNDARY = /([a-z])([A-Z])/g;
const SEPARATORS = /[-_]/g;
const WORD_START = /\b\w/g;

export function valueLabel(value: string): string {
  return (
    CUSTOM_LABELS[value] ??
    value
      .replace(CAMEL_BOUNDARY, "$1 $2")
      .replace(SEPARATORS, " ")
      .replace(WORD_START, (letter) => letter.toUpperCase())
  );
}

export function stateLabel(state: PreviewState): string {
  return valueLabel(state);
}

export function viewLabel(view: PreviewSearch["view"]): string {
  return valueLabel(view);
}

export function skinLabel(skin: PreviewSearch["skin"]): string {
  return THEME_SKINS.find((option) => option.value === skin)?.label ?? valueLabel(skin);
}

export function skinDescription(skin: PreviewSearch["skin"]): string | undefined {
  return THEME_SKINS.find((option) => option.value === skin)?.description;
}

export function paletteLabel(palette: PreviewSearch["palette"]): string {
  return THEME_PALETTES.find((option) => option.value === palette)?.label ?? valueLabel(palette);
}

export function paletteMode(palette: PreviewSearch["palette"]): "light" | "dark" {
  return THEME_PALETTES.find((option) => option.value === palette)?.mode ?? "light";
}

export function textureLabel(texture: PreviewSearch["texture"]): string {
  return THEME_TEXTURES.find((option) => option.value === texture)?.label ?? valueLabel(texture);
}

export function textureDescription(texture: PreviewSearch["texture"]): string | undefined {
  return THEME_TEXTURES.find((option) => option.value === texture)?.description;
}

export function featureLabel(feature: PreviewFeatureKey): string {
  return `Feature ${valueLabel(feature)}`;
}
