import { useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type React from "react";

import { dismissDashboardBoot, removeDashboardBoot } from "./dashboard-boot";
import { applyTheme, DASHBOARD_CANVAS_STYLE_ID, isDashboardPath, persistThemePreference, readThemePreference, resolveTheme, type ResolvedTheme, type ThemePreference } from "./theme";

type ThemeContextValue = {
  readonly preference: ThemePreference;
  readonly mode: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [preference, storePreference] = useState<ThemePreference>(() => (typeof document === "undefined" ? "dark" : readThemePreference(document.cookie)));

  const mode = resolveTheme({ preference, pathname });

  useEffect(() => applyTheme(document.documentElement, mode), [mode]);
  // The first-paint dashboard canvas and opening frame only bridge the wait for the dashboard to mount; other pages keep their own.
  // Effects run children first, so by now the page has drawn its own frame and placeholders for the opening frame to
  // fade over, on every dashboard route.
  useEffect(() => {
    if (isDashboardPath(pathname)) return dismissDashboardBoot();
    document.getElementById(DASHBOARD_CANVAS_STYLE_ID)?.remove();
    removeDashboardBoot();
  }, [pathname]);

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
