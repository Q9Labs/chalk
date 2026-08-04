import { createContext, useContext, useMemo, type ReactNode } from "react";

import { createNativeTheme, Theme, type NativeColorScheme, type NativeTheme } from "./theme";
import { DEFAULT_CHALK_THEME_TOKENS, LIGHT_CHALK_THEME_TOKENS, type ChalkThemeTokenValues } from "./theme-tokens";

export interface NativeThemeInput {
  readonly colorScheme?: NativeColorScheme;
  readonly accent?: string;
  readonly tokens?: Partial<ChalkThemeTokenValues>;
}

const NativeThemeContext = createContext<NativeTheme>(Theme);

export function resolveNativeTheme(input?: NativeThemeInput): NativeTheme {
  const colorScheme = input?.colorScheme ?? "dark";
  const base = colorScheme === "light" ? LIGHT_CHALK_THEME_TOKENS : DEFAULT_CHALK_THEME_TOKENS;
  const accent = input?.accent;
  return createNativeTheme(
    {
      ...base,
      ...input?.tokens,
      ...(accent ? { accent, focus: accent } : {}),
    },
    colorScheme,
  );
}

export function NativeThemeProvider({ children, theme }: { readonly children: ReactNode; readonly theme?: NativeThemeInput }): React.JSX.Element {
  const value = useMemo(() => resolveNativeTheme(theme), [theme?.accent, theme?.colorScheme, theme?.tokens]);
  return <NativeThemeContext.Provider value={value}>{children}</NativeThemeContext.Provider>;
}

export function useNativeTheme(): NativeTheme {
  return useContext(NativeThemeContext);
}
