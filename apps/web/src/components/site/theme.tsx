import { useSyncExternalStore, type ReactNode } from "react";

import type { ThemePreference } from "../../lib/theme";
import { useTheme } from "../../lib/theme-context";
import { Icon } from "./Icon";

// Runs while the page parses, before it paints, so a light preference never flashes the dark default.
// It reads the same cookie as readThemePreference in lib/theme.
const THEME_SCRIPT = `document.currentScript.parentElement.setAttribute("data-chalk-theme",/(?:^|;\\s*)chalk_theme=light(?:;|$)/.test(document.cookie)?"light":"dark")`;

const noSubscription = () => () => {};

/** False while React hydrates the prerendered page, which was drawn dark, then true. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

/**
 * The site's theme follows the call's: one saved preference, dark until someone picks light.
 * During hydration it reports dark, so the first client render matches the prerendered HTML.
 */
export function useSiteTheme(): { readonly theme: ThemePreference; readonly setTheme: (theme: ThemePreference) => void } {
  const { preference, setPreference } = useTheme();
  const hydrated = useHydrated();
  return { theme: hydrated ? preference : "dark", setTheme: setPreference };
}

/** Opens the call's token scope for a site, docs or dashboard page. */
export function SiteRoot({ children }: { readonly children: ReactNode }) {
  const { theme } = useSiteTheme();
  return (
    <div className="site" data-chalk="" data-chalk-theme={theme} suppressHydrationWarning>
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      {children}
    </div>
  );
}

export function ThemeButton() {
  const { theme, setTheme } = useSiteTheme();
  const dark = theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button type="button" className="ib" aria-label={label} data-tip onClick={() => setTheme(dark ? "light" : "dark")}>
      <Icon name="sun" className="when-dark" />
      <Icon name="moon" className="when-light" />
    </button>
  );
}
