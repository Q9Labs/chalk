import { createContext, useContext, type ReactNode } from "react";
import { elevations, palettes, type ColorScheme, type Elevation, type Palette } from "./tokens";

export type Theme = {
  readonly scheme: ColorScheme;
  readonly colors: Palette;
  readonly elevation: Elevation;
};

const themes: Readonly<Record<ColorScheme, Theme>> = {
  dark: { scheme: "dark", colors: palettes.dark, elevation: elevations.dark },
  light: { scheme: "light", colors: palettes.light, elevation: elevations.light },
};

const ThemeContext = createContext<Theme>(themes.dark);

/** Supplies one of two frozen theme objects, so consumers re-render only when the scheme changes. */
export function ThemeProvider({ colorScheme, children }: { readonly colorScheme: ColorScheme; readonly children: ReactNode }): React.JSX.Element {
  return <ThemeContext.Provider value={themes[colorScheme]}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function themeFor(colorScheme: ColorScheme): Theme {
  return themes[colorScheme];
}
