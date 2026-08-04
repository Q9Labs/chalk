export interface NativeShadowToken {
  readonly color: string;
  readonly offset: Readonly<{
    readonly width: number;
    readonly height: number;
  }>;
  readonly opacity: number;
  readonly radius: number;
  readonly elevation: number;
}

export interface NativeAppearanceTokens {
  readonly canvas: string;
  readonly chrome: string;
  readonly stage: string;
  readonly panel: string;
  readonly tileBase: string;
  /** The participant-color wash strength, represented as a 0–1 fraction for native compositing. */
  readonly tileColorStrength: number;
  readonly text: string;
  readonly textMuted: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly control: string;
  readonly controlHover: string;
  readonly controlGroup: string;
  readonly controlPrimary: string;
  readonly controlPrimaryHover: string;
  readonly controlActive: string;
  readonly controlActiveLine: string;
  readonly controlActiveText: string;
  readonly messageRemote: string;
  readonly messageLocal: string;
  readonly messageLocalText: string;
  readonly input: string;
  readonly shadows: Readonly<{
    readonly xs: NativeShadowToken;
    readonly sm: NativeShadowToken;
    readonly control: NativeShadowToken;
  }>;
}

export type NativeTextureKind = "none" | "paper-grain" | "slate";
export type NativeTextureBlendMode = "normal" | "soft-light" | "multiply";

/**
 * A renderer-neutral description of the web texture recipes.
 *
 * React Native does not provide CSS filters or blend modes on every supported
 * platform. Consumers can map these primitives to Views, images, or a native
 * drawing surface without pulling a texture dependency into the SDK.
 */
export interface NativeTextureDescriptor {
  readonly kind: NativeTextureKind;
  readonly blendMode: NativeTextureBlendMode;
  readonly opacity: number;
  readonly tileSize: number | null;
  readonly grain?: Readonly<{
    readonly baseFrequency: number;
    readonly octaves: number;
    readonly opacity: number;
  }>;
  readonly lines?: Readonly<{
    readonly angle: number;
    readonly period: number;
    readonly width: number;
    readonly color: string;
    readonly opacity: number;
  }>;
}

interface ThemePaletteDefinition {
  readonly value: string;
  readonly label: string;
  readonly family: string;
  readonly mode: "light" | "dark";
  readonly swatch: readonly [string, string, string];
  readonly tokens: NativeAppearanceTokens;
}

interface ThemeTextureDefinition {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly descriptor: NativeTextureDescriptor;
}

function createShadow(color: string, offsetY: number, radius: number, opacity: number, elevation: number): NativeShadowToken {
  return {
    color,
    offset: { width: 0, height: offsetY },
    opacity,
    radius,
    elevation,
  };
}

function createShadows(color: string, values: { readonly xs: readonly [number, number, number, number]; readonly sm: readonly [number, number, number, number]; readonly control: readonly [number, number, number, number] }): NativeAppearanceTokens["shadows"] {
  return {
    xs: createShadow(color, ...values.xs),
    sm: createShadow(color, ...values.sm),
    control: createShadow(color, ...values.control),
  };
}

function createTokens(values: Omit<NativeAppearanceTokens, "shadows"> & { readonly shadows: NativeAppearanceTokens["shadows"] }): NativeAppearanceTokens {
  return values;
}

const LIGHT_SHADOWS = createShadows("#0c0e12", {
  xs: [1, 2, 0.08, 1],
  sm: [8, 30, 0.06, 8],
  control: [5, 16, 0.1, 5],
});

const DARK_SHADOWS = createShadows("#000000", {
  xs: [1, 2, 0.3, 1],
  sm: [10, 34, 0.24, 8],
  control: [6, 18, 0.34, 6],
});

const COOL_DARK_SHADOWS = createShadows("#000000", {
  xs: [1, 2, 0.34, 1],
  sm: [12, 36, 0.3, 10],
  control: [6, 18, 0.4, 6],
});

const INK_DARK_SHADOWS = createShadows("#000000", {
  xs: [1, 2, 0.4, 1],
  sm: [12, 38, 0.34, 10],
  control: [7, 20, 0.48, 7],
});

const ESPRESSO_DARK_SHADOWS = createShadows("#000000", {
  xs: [1, 2, 0.38, 1],
  sm: [12, 38, 0.32, 10],
  control: [7, 20, 0.44, 7],
});

const ATELIER_DARK_SHADOWS = createShadows("#000000", {
  xs: [1, 2, 0.34, 1],
  sm: [12, 36, 0.28, 10],
  control: [6, 18, 0.4, 6],
});

const PRISM_DARK_SHADOWS = createShadows("#000000", {
  xs: [1, 2, 0.4, 1],
  sm: [14, 42, 0.35, 12],
  control: [7, 24, 0.46, 7],
});

const OLED_SHADOWS = createShadows("#000000", {
  xs: [0, 0, 0, 0],
  sm: [0, 0, 0, 0],
  control: [6, 18, 0.7, 6],
});

export const THEME_PALETTES = [
  {
    value: "light",
    label: "Chalk Light",
    family: "Chalk",
    mode: "light",
    swatch: ["#f7f6f2", "#ffffff", "#202329"],
    tokens: createTokens({
      canvas: "#f7f6f2",
      chrome: "#fbfaf7",
      stage: "#fbfaf7",
      panel: "#ffffff",
      tileBase: "#f1f0eb",
      tileColorStrength: 0.22,
      text: "#0c0e12",
      textMuted: "#555b65",
      line: "#deddd7",
      lineStrong: "#c9c8c2",
      control: "#ffffff",
      controlHover: "#f1f0eb",
      controlGroup: "#f0efeb",
      controlPrimary: "#202329",
      controlPrimaryHover: "#343840",
      controlActive: "#dff2f7",
      controlActiveLine: "#9dcfe1",
      controlActiveText: "#202329",
      messageRemote: "#f3f2ee",
      messageLocal: "#202329",
      messageLocalText: "#ffffff",
      input: "#fbfaf7",
      shadows: LIGHT_SHADOWS,
    }),
  },
  {
    value: "warm-porcelain",
    label: "Warm Porcelain",
    family: "Warm",
    mode: "light",
    swatch: ["#f6f0e7", "#eadfd2", "#51443c"],
    tokens: createTokens({
      canvas: "#f2ebe2",
      chrome: "#f8f3ec",
      stage: "#eee4dc",
      panel: "#fffaf5",
      tileBase: "#eee4dc",
      tileColorStrength: 0.18,
      text: "#352f2b",
      textMuted: "#70655e",
      line: "#ded2c7",
      lineStrong: "#c8b8aa",
      control: "#fffaf5",
      controlHover: "#eee5dd",
      controlGroup: "#eadfd5",
      controlPrimary: "#51443c",
      controlPrimaryHover: "#66564b",
      controlActive: "#dceef2",
      controlActiveLine: "#6aa8ba",
      controlActiveText: "#29383d",
      messageRemote: "#eee7e0",
      messageLocal: "#51443c",
      messageLocalText: "#fffaf5",
      input: "#fffdf9",
      shadows: createShadows("#48372b", {
        xs: [1, 2, 0.08, 1],
        sm: [10, 30, 0.08, 8],
        control: [6, 18, 0.13, 6],
      }),
    }),
  },
  {
    value: "cool-mist",
    label: "Cool Mist",
    family: "Graphite",
    mode: "light",
    swatch: ["#f2f6f8", "#dfe8ee", "#34414d"],
    tokens: createTokens({
      canvas: "#edf2f5",
      chrome: "#f6f8fa",
      stage: "#e7eef2",
      panel: "#fbfdfe",
      tileBase: "#e7eef2",
      tileColorStrength: 0.18,
      text: "#24313b",
      textMuted: "#65727e",
      line: "#d4dde3",
      lineStrong: "#b8c6cf",
      control: "#fbfdfe",
      controlHover: "#e6edf1",
      controlGroup: "#e1e9ee",
      controlPrimary: "#34414d",
      controlPrimaryHover: "#465563",
      controlActive: "#dceff7",
      controlActiveLine: "#5599b5",
      controlActiveText: "#21343d",
      messageRemote: "#e9eef1",
      messageLocal: "#34414d",
      messageLocalText: "#f8fbfc",
      input: "#ffffff",
      shadows: createShadows("#233643", {
        xs: [1, 2, 0.08, 1],
        sm: [10, 32, 0.08, 8],
        control: [6, 18, 0.13, 6],
      }),
    }),
  },
  {
    value: "paper-and-ink",
    label: "Paper & Ink",
    family: "Ink",
    mode: "light",
    swatch: ["#fafaf7", "#e8e8e2", "#15171a"],
    tokens: createTokens({
      canvas: "#f4f4f0",
      chrome: "#fafaf7",
      stage: "#efefea",
      panel: "#ffffff",
      tileBase: "#eeeeea",
      tileColorStrength: 0.14,
      text: "#101214",
      textMuted: "#555b62",
      line: "#d7d8d5",
      lineStrong: "#b8bab8",
      control: "#ffffff",
      controlHover: "#e9e9e5",
      controlGroup: "#e8e8e3",
      controlPrimary: "#15171a",
      controlPrimaryHover: "#2b2e32",
      controlActive: "#e3eff8",
      controlActiveLine: "#196da8",
      controlActiveText: "#101214",
      messageRemote: "#eeeeea",
      messageLocal: "#15171a",
      messageLocalText: "#ffffff",
      input: "#ffffff",
      shadows: createShadows("#101214", {
        xs: [1, 2, 0.1, 1],
        sm: [8, 26, 0.08, 8],
        control: [5, 16, 0.14, 5],
      }),
    }),
  },
  {
    value: "cream-and-clay",
    label: "Cream & Clay",
    family: "Espresso",
    mode: "light",
    swatch: ["#fbf2e7", "#e8c8b0", "#7a4329"],
    tokens: createTokens({
      canvas: "#f6eadf",
      chrome: "#fbf3ea",
      stage: "#f1ddcd",
      panel: "#fffaf4",
      tileBase: "#efddcf",
      tileColorStrength: 0.22,
      text: "#432d24",
      textMuted: "#7d6458",
      line: "#e2cfc0",
      lineStrong: "#c8ab97",
      control: "#fffaf4",
      controlHover: "#f0dfd1",
      controlGroup: "#ead6c6",
      controlPrimary: "#5c3828",
      controlPrimaryHover: "#744733",
      controlActive: "#e8e8d5",
      controlActiveLine: "#87945e",
      controlActiveText: "#354025",
      messageRemote: "#f1e5da",
      messageLocal: "#5c3828",
      messageLocalText: "#fffaf4",
      input: "#fffdf8",
      shadows: createShadows("#563222", {
        xs: [1, 2, 0.1, 1],
        sm: [10, 32, 0.09, 8],
        control: [6, 18, 0.15, 6],
      }),
    }),
  },
  {
    value: "studio-canvas",
    label: "Studio Canvas",
    family: "Atelier",
    mode: "light",
    swatch: ["#f7f3e9", "#dce6d5", "#48594b"],
    tokens: createTokens({
      canvas: "#f0eee5",
      chrome: "#f8f5ec",
      stage: "#ebe9de",
      panel: "#fdfbf5",
      tileBase: "#e9e7dc",
      tileColorStrength: 0.22,
      text: "#303832",
      textMuted: "#657067",
      line: "#d8d7ca",
      lineStrong: "#b9bdad",
      control: "#fdfbf5",
      controlHover: "#e8e7dc",
      controlGroup: "#e4e4d8",
      controlPrimary: "#48594b",
      controlPrimaryHover: "#5a6e5d",
      controlActive: "#dceff2",
      controlActiveLine: "#5e9bab",
      controlActiveText: "#294047",
      messageRemote: "#ecebe2",
      messageLocal: "#48594b",
      messageLocalText: "#fbfaf4",
      input: "#fffef9",
      shadows: createShadows("#303832", {
        xs: [1, 2, 0.08, 1],
        sm: [10, 30, 0.08, 8],
        control: [6, 18, 0.13, 6],
      }),
    }),
  },
  {
    value: "prism-daylight",
    label: "Prism Daylight",
    family: "Prism",
    mode: "light",
    swatch: ["#faf9ff", "#e8ddfa", "#4c2e78"],
    tokens: createTokens({
      canvas: "#f4f1fb",
      chrome: "#fbf9ff",
      stage: "#eee8fa",
      panel: "#fefcff",
      tileBase: "#eee8f7",
      tileColorStrength: 0.26,
      text: "#2b2037",
      textMuted: "#71657e",
      line: "#ded5ea",
      lineStrong: "#c4b4d8",
      control: "#fefcff",
      controlHover: "#ebe3f5",
      controlGroup: "#e9e1f2",
      controlPrimary: "#4c2e78",
      controlPrimaryHover: "#614091",
      controlActive: "#e5dcfb",
      controlActiveLine: "#7651d2",
      controlActiveText: "#34204f",
      messageRemote: "#eee9f4",
      messageLocal: "#3b245c",
      messageLocalText: "#ffffff",
      input: "#ffffff",
      shadows: createShadows("#36214e", {
        xs: [1, 2, 0.09, 1],
        sm: [12, 36, 0.1, 10],
        control: [7, 20, 0.16, 7],
      }),
    }),
  },
  {
    value: "signal-white",
    label: "Signal White",
    family: "Signal",
    mode: "light",
    swatch: ["#ffffff", "#ddecf9", "#0879d9"],
    tokens: createTokens({
      canvas: "#f3f7fb",
      chrome: "#ffffff",
      stage: "#edf4fa",
      panel: "#ffffff",
      tileBase: "#eef4f8",
      tileColorStrength: 0.22,
      text: "#0c1117",
      textMuted: "#596674",
      line: "#d8e0e7",
      lineStrong: "#b5c2cd",
      control: "#ffffff",
      controlHover: "#e8f0f6",
      controlGroup: "#e5edf3",
      controlPrimary: "#111820",
      controlPrimaryHover: "#28323d",
      controlActive: "#e1f0ff",
      controlActiveLine: "#1684e2",
      controlActiveText: "#0b4f87",
      messageRemote: "#edf1f4",
      messageLocal: "#111820",
      messageLocalText: "#ffffff",
      input: "#ffffff",
      shadows: createShadows("#0c263e", {
        xs: [1, 2, 0.09, 1],
        sm: [10, 32, 0.08, 8],
        control: [6, 18, 0.14, 6],
      }),
    }),
  },
  {
    value: "warm-charcoal",
    label: "Warm Charcoal",
    family: "Warm",
    mode: "dark",
    swatch: ["#151513", "#292925", "#65b4d0"],
    tokens: createTokens({
      canvas: "#151513",
      chrome: "#191917",
      stage: "#1d1d1a",
      panel: "#21211d",
      tileBase: "#1c1c19",
      tileColorStrength: 0.2,
      text: "#f4f3ee",
      textMuted: "#a8a79f",
      line: "#34342e",
      lineStrong: "#4b4a42",
      control: "#292925",
      controlHover: "#34342e",
      controlGroup: "#20201c",
      controlPrimary: "#252823",
      controlPrimaryHover: "#353a33",
      controlActive: "#263941",
      controlActiveLine: "#65b4d0",
      controlActiveText: "#f4f3ee",
      messageRemote: "#2a2a25",
      messageLocal: "#27323a",
      messageLocalText: "#f4f3ee",
      input: "#1a1a17",
      shadows: DARK_SHADOWS,
    }),
  },
  {
    value: "cool-graphite",
    label: "Cool Graphite",
    family: "Graphite",
    mode: "dark",
    swatch: ["#101318", "#202632", "#55aac9"],
    tokens: createTokens({
      canvas: "#101318",
      chrome: "#141820",
      stage: "#171c24",
      panel: "#1b2028",
      tileBase: "#18202a",
      tileColorStrength: 0.22,
      text: "#f3f6f8",
      textMuted: "#9da6b2",
      line: "#303744",
      lineStrong: "#46505f",
      control: "#202632",
      controlHover: "#2a3240",
      controlGroup: "#191f28",
      controlPrimary: "#242b35",
      controlPrimaryHover: "#313b49",
      controlActive: "#172f43",
      controlActiveLine: "#55aac9",
      controlActiveText: "#f3f6f8",
      messageRemote: "#272e39",
      messageLocal: "#141c25",
      messageLocalText: "#f3f6f8",
      input: "#151a22",
      shadows: COOL_DARK_SHADOWS,
    }),
  },
  {
    value: "high-contrast-ink",
    label: "High-contrast Ink",
    family: "Ink",
    mode: "dark",
    swatch: ["#0c0e12", "#242932", "#63b9d7"],
    tokens: createTokens({
      canvas: "#0c0e12",
      chrome: "#12151a",
      stage: "#151920",
      panel: "#191d23",
      tileBase: "#171b22",
      tileColorStrength: 0.19,
      text: "#fafaf7",
      textMuted: "#a3a8b0",
      line: "#343941",
      lineStrong: "#4b525d",
      control: "#242932",
      controlHover: "#303640",
      controlGroup: "#171b21",
      controlPrimary: "#1f242c",
      controlPrimaryHover: "#2c333d",
      controlActive: "#163247",
      controlActiveLine: "#63b9d7",
      controlActiveText: "#fafaf7",
      messageRemote: "#252a32",
      messageLocal: "#10141a",
      messageLocalText: "#fafaf7",
      input: "#14181e",
      shadows: INK_DARK_SHADOWS,
    }),
  },
  {
    value: "espresso-night",
    label: "Espresso Night",
    family: "Espresso",
    mode: "dark",
    swatch: ["#15110f", "#2c211d", "#c98656"],
    tokens: createTokens({
      canvas: "#15110f",
      chrome: "#1a1512",
      stage: "#1e1714",
      panel: "#211916",
      tileBase: "#1d1614",
      tileColorStrength: 0.2,
      text: "#f5ede3",
      textMuted: "#b8a79a",
      line: "#4a3930",
      lineStrong: "#664b3d",
      control: "#2c211d",
      controlHover: "#3a2a24",
      controlGroup: "#211916",
      controlPrimary: "#2a211e",
      controlPrimaryHover: "#3b2d28",
      controlActive: "#3d2c24",
      controlActiveLine: "#c98656",
      controlActiveText: "#f5ede3",
      messageRemote: "#35271f",
      messageLocal: "#1d252b",
      messageLocalText: "#f5ede3",
      input: "#1a1412",
      shadows: ESPRESSO_DARK_SHADOWS,
    }),
  },
  {
    value: "chalkboard-atelier",
    label: "Chalkboard Atelier",
    family: "Atelier",
    mode: "dark",
    swatch: ["#0d1714", "#20332c", "#76bed1"],
    tokens: createTokens({
      canvas: "#0d1714",
      chrome: "#111d19",
      stage: "#14221d",
      panel: "#1b2c26",
      tileBase: "#15241f",
      tileColorStrength: 0.18,
      text: "#eff3e9",
      textMuted: "#9bab9f",
      line: "#30473d",
      lineStrong: "#466355",
      control: "#20332c",
      controlHover: "#2a4138",
      controlGroup: "#172720",
      controlPrimary: "#1e3029",
      controlPrimaryHover: "#2c443a",
      controlActive: "#1c3b40",
      controlActiveLine: "#76bed1",
      controlActiveText: "#eff3e9",
      messageRemote: "#263a32",
      messageLocal: "#182d2f",
      messageLocalText: "#eff3e9",
      input: "#13211c",
      shadows: ATELIER_DARK_SHADOWS,
    }),
  },
  {
    value: "prism-nocturne",
    label: "Prism Nocturne",
    family: "Prism",
    mode: "dark",
    swatch: ["#100d17", "#231b30", "#9a63e6"],
    tokens: createTokens({
      canvas: "#100d17",
      chrome: "#14101d",
      stage: "#17131e",
      panel: "#1a1424",
      tileBase: "#18121f",
      tileColorStrength: 0.26,
      text: "#f5f0fa",
      textMuted: "#a99db3",
      line: "#3b3049",
      lineStrong: "#58446d",
      control: "#231b30",
      controlHover: "#302340",
      controlGroup: "#1b1525",
      controlPrimary: "#251b32",
      controlPrimaryHover: "#352549",
      controlActive: "#2b1743",
      controlActiveLine: "#9a63e6",
      controlActiveText: "#f5f0fa",
      messageRemote: "#2b2334",
      messageLocal: "#191321",
      messageLocalText: "#f5f0fa",
      input: "#17111f",
      shadows: PRISM_DARK_SHADOWS,
    }),
  },
  {
    value: "oled-signal",
    label: "OLED Signal",
    family: "Signal",
    mode: "dark",
    swatch: ["#000000", "#11151a", "#2f86ff"],
    tokens: createTokens({
      canvas: "#000000",
      chrome: "#030405",
      stage: "#000000",
      panel: "#07090c",
      tileBase: "#07090c",
      tileColorStrength: 0.12,
      text: "#f7f8fa",
      textMuted: "#8b949e",
      line: "#242a31",
      lineStrong: "#3a424c",
      control: "#11151a",
      controlHover: "#1a2027",
      controlGroup: "#080a0d",
      controlPrimary: "#11151a",
      controlPrimaryHover: "#20262e",
      controlActive: "#081b32",
      controlActiveLine: "#2f86ff",
      controlActiveText: "#f7f8fa",
      messageRemote: "#14171b",
      messageLocal: "#090b0f",
      messageLocalText: "#f7f8fa",
      input: "#080a0d",
      shadows: OLED_SHADOWS,
    }),
  },
] as const satisfies readonly ThemePaletteDefinition[];

export type ThemePalette = (typeof THEME_PALETTES)[number]["value"];
export type ThemeMode = (typeof THEME_PALETTES)[number]["mode"];

export const THEME_TEXTURES = [
  {
    value: "none",
    label: "Clean",
    description: "Pure color with no material overlay.",
    descriptor: {
      kind: "none",
      blendMode: "normal",
      opacity: 0,
      tileSize: null,
    },
  },
  {
    value: "paper",
    label: "Paper Grain",
    description: "A fine organic grain over the selected palette.",
    descriptor: {
      kind: "paper-grain",
      blendMode: "soft-light",
      opacity: 0.24,
      tileSize: 180,
      grain: { baseFrequency: 0.74, octaves: 4, opacity: 0.24 },
    },
  },
  {
    value: "slate",
    label: "Slate",
    description: "A subtle directional mineral texture.",
    descriptor: {
      kind: "slate",
      blendMode: "soft-light",
      opacity: 0.2,
      tileSize: 220,
      grain: { baseFrequency: 0.36, octaves: 5, opacity: 0.2 },
      lines: { angle: 7, period: 19, width: 1, color: "#ffffff", opacity: 0.018 },
    },
  },
] as const satisfies readonly ThemeTextureDefinition[];

export type ThemeTexture = (typeof THEME_TEXTURES)[number]["value"];

export interface ThemeAppearance {
  readonly palette: ThemePalette;
  readonly texture: ThemeTexture;
}

export interface NativeAppearance {
  readonly palette: ThemePalette;
  readonly mode: ThemeMode;
  readonly texture: ThemeTexture;
  readonly tokens: NativeAppearanceTokens;
  readonly textureDescriptor: NativeTextureDescriptor;
}

const DARK_THEME_PALETTES = new Set<ThemePalette>(THEME_PALETTES.filter((palette) => palette.mode === "dark").map((palette) => palette.value));

export function isDarkThemePalette(palette: ThemePalette): boolean {
  return DARK_THEME_PALETTES.has(palette);
}

export function getThemeMode(palette: ThemePalette): ThemeMode {
  return isDarkThemePalette(palette) ? "dark" : "light";
}

function resolvePalette(palette: ThemePalette): (typeof THEME_PALETTES)[number] {
  return THEME_PALETTES.find((entry) => entry.value === palette)!;
}

function resolveTexture(texture: ThemeTexture): (typeof THEME_TEXTURES)[number] {
  return THEME_TEXTURES.find((entry) => entry.value === texture)!;
}

function resolveTextureDescriptor(texture: ThemeTexture, mode: ThemeMode): NativeTextureDescriptor {
  const descriptor: NativeTextureDescriptor = resolveTexture(texture).descriptor;
  if (texture !== "slate") return descriptor;

  const light = mode === "light";
  return {
    ...descriptor,
    blendMode: light ? "multiply" : "soft-light",
    opacity: light ? 0.16 : 0.2,
    grain: { ...descriptor.grain!, opacity: light ? 0.16 : 0.2 },
    lines: { ...descriptor.lines!, color: light ? "#0c0e12" : "#ffffff", opacity: light ? 0.022 : 0.018 },
  };
}

export function resolveNativeAppearance(appearance: Partial<ThemeAppearance> = {}): NativeAppearance {
  const palette = resolvePalette(appearance.palette ?? "light");
  const mode = getThemeMode(palette.value);
  const texture = (appearance.texture ?? "none") as ThemeTexture;

  return {
    palette: palette.value,
    mode,
    texture,
    tokens: palette.tokens,
    textureDescriptor: resolveTextureDescriptor(texture, mode),
  };
}
