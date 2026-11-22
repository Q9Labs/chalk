import { useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type React from "react";

import { applyTheme, clearCallBoot, DASHBOARD_CANVAS_STYLE_ID, isDashboardPath, persistThemePreference, readThemePreference, resolveTheme, type ResolvedTheme, type ThemePreference } from "./theme";
import { DASHBOARD_BOOT_ID } from "./dashboard-boot-script";

type ThemeContextValue = {
  readonly preference: ThemePreference;
  readonly mode: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** The first-paint canvas is painted from the saved theme, so it must not outlive the wait it covers: a later theme choice or page would sit on the old colour. */
const removeDashboardCanvas = () => document.getElementById(DASHBOARD_CANVAS_STYLE_ID)?.remove();

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [preference, storePreference] = useState<ThemePreference>(() => (typeof document === "undefined" ? "dark" : readThemePreference(document.cookie)));

  const mode = resolveTheme({ preference, pathname });

  useEffect(() => applyTheme(document.documentElement, mode), [mode]);
  useEffect(() => clearCallBoot(document.documentElement, pathname), [pathname]);
  // The first-paint dashboard canvas and opening frame only bridge the wait for the dashboard to mount; other pages keep their own.
  // Effects run children first, so by now the page has drawn its own frame and placeholders for the opening frame to
  // fade over, on every dashboard route.
  useEffect(() => {
    if (!isDashboardPath(pathname)) {
      removeDashboardCanvas();
      // Leaving the dashboard before the frame faded takes it away at once.
      document.getElementById(DASHBOARD_BOOT_ID)?.remove();
      return;
    }
    // Loaded here: only a dashboard page has a frame to dismiss, so the call route never carries the code.
    let cancelled = false;
    let stop = () => {};
    void import("./dashboard-boot").then((boot) => {
      if (!cancelled) stop = boot.dismissDashboardBoot(document.getElementById(DASHBOARD_BOOT_ID), removeDashboardCanvas);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [pathname]);

  const setPreference = useCallback((next: ThemePreference) => {
    storePreference(next);
    persistThemePreference(next);
    removeDashboardCanvas();
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ preference, mode, setPreference }), [preference, mode, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("Theme must be provided above any control that reads or changes it.");
  return value;
}
