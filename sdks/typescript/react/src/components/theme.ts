export const THEME_PALETTES = [
  { value: "light", label: "Chalk Light", family: "Chalk", mode: "light", swatch: ["#f7f6f2", "#ffffff", "#202329"] },
  { value: "warm-porcelain", label: "Warm Porcelain", family: "Warm", mode: "light", swatch: ["#f6f0e7", "#eadfd2", "#51443c"] },
  { value: "cool-mist", label: "Cool Mist", family: "Graphite", mode: "light", swatch: ["#f2f6f8", "#dfe8ee", "#34414d"] },
  { value: "paper-and-ink", label: "Paper & Ink", family: "Ink", mode: "light", swatch: ["#fafaf7", "#e8e8e2", "#15171a"] },
  { value: "cream-and-clay", label: "Cream & Clay", family: "Espresso", mode: "light", swatch: ["#fbf2e7", "#e8c8b0", "#7a4329"] },
  { value: "studio-canvas", label: "Studio Canvas", family: "Atelier", mode: "light", swatch: ["#f7f3e9", "#dce6d5", "#48594b"] },
  { value: "prism-daylight", label: "Prism Daylight", family: "Prism", mode: "light", swatch: ["#faf9ff", "#e8ddfa", "#4c2e78"] },
  { value: "signal-white", label: "Signal White", family: "Signal", mode: "light", swatch: ["#ffffff", "#ddecf9", "#0879d9"] },
  { value: "warm-charcoal", label: "Warm Charcoal", family: "Warm", mode: "dark", swatch: ["#151513", "#292925", "#65b4d0"] },
  { value: "cool-graphite", label: "Cool Graphite", family: "Graphite", mode: "dark", swatch: ["#101318", "#202632", "#55aac9"] },
  { value: "high-contrast-ink", label: "High-contrast Ink", family: "Ink", mode: "dark", swatch: ["#0c0e12", "#242932", "#63b9d7"] },
  { value: "espresso-night", label: "Espresso Night", family: "Espresso", mode: "dark", swatch: ["#15110f", "#2c211d", "#c98656"] },
  { value: "chalkboard-atelier", label: "Chalkboard Atelier", family: "Atelier", mode: "dark", swatch: ["#0d1714", "#20332c", "#76bed1"] },
  { value: "prism-nocturne", label: "Prism Nocturne", family: "Prism", mode: "dark", swatch: ["#100d17", "#231b30", "#9a63e6"] },
  { value: "cosmic-chalk", label: "Cosmic Chalk", family: "Cosmic", mode: "dark", swatch: ["#080f20", "#10182b", "#8fdcff"] },
  { value: "oled-signal", label: "OLED Signal", family: "Signal", mode: "dark", swatch: ["#000000", "#11151a", "#2f86ff"] },
] as const;

export type ThemePalette = (typeof THEME_PALETTES)[number]["value"];
export type ThemeMode = (typeof THEME_PALETTES)[number]["mode"];

export const THEME_TEXTURES = [
  { value: "none", label: "Clean", description: "Pure color with no material overlay." },
  { value: "paper", label: "Paper Grain", description: "A fine organic grain over the selected palette." },
  { value: "slate", label: "Slate", description: "A subtle directional mineral texture." },
] as const;

export type ThemeTexture = (typeof THEME_TEXTURES)[number]["value"];

export interface ThemeAppearance {
  readonly palette: ThemePalette;
  readonly texture: ThemeTexture;
}

const DARK_THEME_PALETTES = new Set<ThemePalette>(THEME_PALETTES.filter((palette) => palette.mode === "dark").map((palette) => palette.value));

export function isDarkThemePalette(palette: ThemePalette): boolean {
  return DARK_THEME_PALETTES.has(palette);
}

export function getThemeMode(palette: ThemePalette): ThemeMode {
  return isDarkThemePalette(palette) ? "dark" : "light";
}
