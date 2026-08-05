import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { NativeAppearance } from "./appearance";
import { createNativeTheme, Theme, type NativeColorScheme, type NativeTheme } from "./theme";
import { DEFAULT_CHALK_THEME_TOKENS, LIGHT_CHALK_THEME_TOKENS, type ChalkThemeTokenValues } from "./theme-tokens";

export interface NativeThemeInput {
  readonly colorScheme?: NativeColorScheme;
  readonly accent?: string;
  readonly tokens?: Partial<ChalkThemeTokenValues>;
}

const NativeThemeContext = createContext<NativeTheme>(Theme);

export function resolveNativeTheme(input?: NativeThemeInput, appearance?: NativeAppearance): NativeTheme {
  const colorScheme = input?.colorScheme ?? appearance?.mode ?? "dark";
  const base = appearance ? themeTokensFromAppearance(appearance) : colorScheme === "light" ? LIGHT_CHALK_THEME_TOKENS : DEFAULT_CHALK_THEME_TOKENS;
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

export function NativeThemeProvider({ appearance, children, theme }: { readonly appearance?: NativeAppearance; readonly children: ReactNode; readonly theme?: NativeThemeInput }): React.JSX.Element {
  const value = useMemo(() => resolveNativeTheme(theme, appearance), [appearance, theme?.accent, theme?.colorScheme, theme?.tokens]);
  return <NativeThemeContext.Provider value={value}>{children}</NativeThemeContext.Provider>;
}

export function useNativeTheme(): NativeTheme {
  return useContext(NativeThemeContext);
}

function themeTokensFromAppearance(appearance: NativeAppearance): ChalkThemeTokenValues {
  const tokens = appearance.tokens;
  const base = appearance.mode === "light" ? LIGHT_CHALK_THEME_TOKENS : DEFAULT_CHALK_THEME_TOKENS;
  return {
    ...base,
    canvas: tokens.canvas,
    chrome: tokens.panel,
    surface: tokens.panel,
    stage: tokens.stage,
    text: tokens.text,
    mutedText: tokens.textMuted,
    line: tokens.line,
    focus: tokens.controlActiveLine,
    accent: tokens.controlPrimary,
    accentText: tokens.messageLocalText,
  };
}
