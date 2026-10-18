import { Easing } from "react-native-reanimated";

/**
 * Design tokens for the call, copied from the approved mobile mockup
 * (`.dev` and `.dev.light` in mobile-mockup.html) and named by role as in design.md.
 * This file and `fixed` below are the only places a colour literal may appear.
 */
export type ColorScheme = "dark" | "light";

export type Palette = {
  /** Call background and status pages. */
  readonly canvas: string;
  /** Sheets, cards, the people pill and header buttons. */
  readonly surface: string;
  /** Tile background and the letterbox colour of shared content. */
  readonly tile: string;
  /** Round dock buttons, fields, chat bubbles, selected rows. */
  readonly raised: string;
  /** Menus, popovers and toasts. */
  readonly popover: string;
  /** Pressed row, expanded control, the default pill button. */
  readonly hover: string;
  /** Pressed surface of a raised control, switch track when off. */
  readonly pressed: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly text: string;
  readonly textStrong: string;
  readonly textSoft: string;
  readonly textMuted: string;
  /** Focus ring: the mockup draws `outline: 2px solid var(--tx)`. */
  readonly focus: string;
  readonly danger: string;
  readonly dangerPressed: string;
  readonly dangerText: string;
  readonly success: string;
  readonly warning: string;
  /** The call's accent: unread dots and your own reactions. */
  readonly info: string;
};

const dark: Palette = {
  canvas: "#0B0C0E",
  surface: "#151619",
  tile: "#151619",
  raised: "#1D1F23",
  popover: "#1D1F23",
  hover: "#272A2F",
  pressed: "#30333A",
  line: "rgba(255,255,255,0.08)",
  lineStrong: "rgba(255,255,255,0.14)",
  text: "#ECECEE",
  textStrong: "#FFFFFF",
  textSoft: "#C4C6CC",
  textMuted: "#9A9CA3",
  focus: "#ECECEE",
  danger: "#E5484D",
  dangerPressed: "#C93D42",
  dangerText: "#FF6B6B",
  success: "#80B879",
  warning: "#D9B641",
  info: "#55AAC9",
};

const light: Palette = {
  canvas: "#F3F3F5",
  surface: "#FFFFFF",
  tile: "#E2E2E7",
  raised: "#ECECF0",
  popover: "#FFFFFF",
  hover: "#E1E1E6",
  pressed: "#D3D3D9",
  line: "rgba(0,0,0,0.09)",
  lineStrong: "rgba(0,0,0,0.15)",
  text: "#18181B",
  textStrong: "#000000",
  textSoft: "#3D3E45",
  textMuted: "#5C5D65",
  focus: "#18181B",
  danger: "#D93A3F",
  dangerPressed: "#C93D42",
  dangerText: "#BF272C",
  success: "#2B8A3E",
  warning: "#8A6400",
  info: "#1B70A0",
};

export const palettes: Readonly<Record<ColorScheme, Palette>> = { dark, light };

/** Colours that stay the same in both themes, because they sit on video or carry a fixed meaning. */
export const fixed = {
  overlay: "rgba(12,14,18,0.75)",
  overlayStrong: "rgba(12,14,18,0.82)",
  overlayPressed: "rgba(40,42,48,0.95)",
  overlayText: "#FFFFFF",
  overlayDanger: "#FF6B6B",
  overlayWarning: "#E2BD3A",
  onDanger: "#FFFFFF",
  hand: "#DCB740",
  handText: "#16140C",
  scrim: "rgba(0,0,0,0.55)",
  liveRing: "rgba(255,255,255,0.9)",
  liveRingShade: "rgba(0,0,0,0.35)",
  switchKnob: "#FFFFFF",
  /** QR codes stay black on white in both themes so every camera reads them. */
  qrLight: "#FFFFFF",
  qrDark: "#000000",
  shadow: "#000000",
  transparent: "transparent",
  /** The selected segment of a compact segmented control. */
  segmentShadow: "0px 1px 2px rgba(0,0,0,0.2)",
} as const;

/** Avatar backgrounds, chosen by a hash of the person's name. */
export const identityColors = ["#315F72", "#5C6650", "#6B5B4F", "#64576B", "#49645D", "#665D42", "#4D5D73", "#6D5158"] as const;

/**
 * Shadows. In the light theme, controls that sit on the canvas carry a one-pixel `line` ring
 * and floating surfaces add a soft shadow; the dark theme uses the heavier mockup shadows.
 */
export type Elevation = {
  readonly popover: string;
  readonly toast: string;
  /** Controls on the canvas (dock buttons, people pill) get a one-pixel ring in light. */
  readonly ringOnCanvas: boolean;
};

export const elevations: Readonly<Record<ColorScheme, Elevation>> = {
  dark: { popover: "0px 12px 32px rgba(0,0,0,0.5)", toast: "0px 8px 24px rgba(0,0,0,0.4)", ringOnCanvas: false },
  light: { popover: "0px 0px 0px 1px rgba(0,0,0,0.09), 0px 12px 32px rgba(0,0,0,0.12)", toast: "0px 0px 0px 1px rgba(0,0,0,0.09), 0px 12px 32px rgba(0,0,0,0.12)", ringOnCanvas: true },
};

export type FontWeight = 400 | 500 | 600 | 700;

/** Figtree is embedded by the app; these are its PostScript names, which iOS and Android both resolve. */
export const fontFamilies: Readonly<Record<FontWeight, string>> = {
  400: "Figtree-Regular",
  500: "Figtree-Medium",
  600: "Figtree-SemiBold",
  700: "Figtree-Bold",
};

const LINE_HEIGHT = 1.4;

function textStyle(fontSize: number, weight: FontWeight) {
  return { fontFamily: fontFamilies[weight], fontSize, lineHeight: fontSize * LINE_HEIGHT } as const;
}

/** The call type scale. Text is Figtree at a line height of 1.4, in sentence case. */
export const type = {
  statusTitle: textStyle(22, 600),
  limboTitle: textStyle(20, 600),
  progress: textStyle(17, 600),
  sheetTitle: textStyle(16, 600),
  phoneRow: textStyle(16, 400),
  cardTitle: textStyle(15, 600),
  wideButton: textStyle(15, 600),
  body: textStyle(14, 400),
  bodyMedium: textStyle(14, 500),
  bodyStrong: textStyle(14, 600),
  button: textStyle(13, 600),
  meta: textStyle(13, 400),
  label: textStyle(12, 500),
  section: textStyle(12, 600),
  caption: textStyle(11, 600),
} as const;

export type TypeStyle = keyof typeof type;

export const radii = {
  tag: 6,
  field: 10,
  menuRow: 9,
  menu: 12,
  tile: 12,
  tilePhone: 14,
  card: 16,
  sheet: 24,
  round: 999,
} as const;

/** Four-point grid. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;

export const sizes = {
  control: 44,
  dockPhone: 52,
  headerButton: 40,
  menuRow: 40,
  menuRowPhone: 48,
  toastMinHeight: 48,
  handleWidth: 36,
  handleHeight: 5,
} as const;

/** Durations in milliseconds, from the mockup's CSS transitions. */
export const durations = {
  press: 150,
  chromeFade: 250,
  menu: 180,
  toastIn: 200,
  toastOut: 160,
  card: 200,
  sheet: 240,
  scrim: 200,
  move: 220,
  enter: 220,
  leave: 160,
  copyMorph: 200,
  copyReset: 2000,
  veil: 300,
  avatarTurn: 300,
  speakingLevel: 90,
  landscapeHide: 4000,
  toastInfo: 5000,
} as const;

/** `--ease` in the mockup: menus, toasts, cards, sheets, the copy morph. */
const emphasized = Easing.bezier(0.16, 1, 0.3, 1);
/** `EASE` in the mockup: tiles moving between frames. */
const move = Easing.bezier(0.2, 0.8, 0.2, 1);
/** CSS `ease-out`: presses, fades, the scrim. */
const easeOut = Easing.bezier(0, 0, 0.58, 1);
/** The avatar's turn to the front. */
const standard = Easing.bezier(0.4, 0, 0.2, 1);

export const easings = { emphasized, move, easeOut, standard, linear: Easing.linear } as const;

/** Scale of a pressed control, per control family. */
export const pressScale = { round: 0.94, pill: 0.97, small: 0.92, big: 0.98 } as const;
