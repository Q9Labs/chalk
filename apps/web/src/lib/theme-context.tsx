import { useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type React from "react";

import { applyThemeMode, persistThemePreference, readThemePreference, resolveThemeMode, systemThemeMode, watchSystemThemeMode, type ThemeMode, type ThemePreference } from "./theme";

type ThemeContextValue = {
  readonly preference: ThemePreference;
  readonly mode: ThemeMode;
  readonly setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [preference, storePreference] = useState<ThemePreference>(() => (typeof document === "undefined" ? "system" : readThemePreference(document.cookie)));
  const [systemMode, setSystemMode] = useState<ThemeMode>(systemThemeMode);

  useEffect(() => watchSystemThemeMode(setSystemMode), []);

  const mode = resolveThemeMode({ preference, pathname, systemMode });

  useEffect(() => applyThemeMode(document.documentElement, mode), [mode]);

  const setPreference = useCallback((next: ThemePreference) => {
    storePreference(next);
    persistThemePreference(next);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ preference, mode, setPreference }), [preference, mode, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("Theme must be provided above any control that reads or changes it.");
  return value;
}
