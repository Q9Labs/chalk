import { useSyncExternalStore, type ReactNode } from "react";

import type { ThemePreference } from "../../lib/theme";
import { SIGNED_IN_COOKIE } from "../../lib/signed-in-hint";
import { useTheme } from "../../lib/theme-context";
import { Icon } from "./Icon";

// Runs while the page parses, before it paints, so a light preference never flashes the dark default.
// It reads the same cookie as readThemePreference in lib/theme, and marks a signed-in visitor so the
// site header can swap Sign in for Dashboard in CSS, with no flash and no hydration mismatch.
const THEME_SCRIPT = `var r=document.currentScript.parentElement;r.setAttribute("data-chalk-theme",/(?:^|;\\s*)chalk_theme=light(?:;|$)/.test(document.cookie)?"light":"dark");if(/(?:^|;\\s*)${SIGNED_IN_COOKIE}=1(?:;|$)/.test(document.cookie))r.setAttribute("data-chalk-signed-in","")`;

const SIGNED_IN_PATTERN = new RegExp(`(?:^|;\\s*)${SIGNED_IN_COOKIE}=1(?:;|$)`);

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

/** True when this browser holds the session hint. False while hydrating, where the inline script has already marked the page. */
function useSignedInHint(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => SIGNED_IN_PATTERN.test(document.cookie),
    () => false,
  );
}

/** Opens the call's token scope for a site, docs or dashboard page. */
export function SiteRoot({ children }: { readonly children: ReactNode }) {
  const { theme } = useSiteTheme();
  const signedIn = useSignedInHint();
  return (
    <div className="site" data-chalk="" data-chalk-theme={theme} data-chalk-signed-in={signedIn ? "" : undefined} suppressHydrationWarning>
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
