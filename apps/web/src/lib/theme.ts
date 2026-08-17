export type ThemePreference = "system" | "light" | "dark";
export type ThemeMode = "light" | "dark";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export const THEME_COOKIE_NAME = "chalk_theme";
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const THEME_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${THEME_COOKIE_NAME}=([^;]*)`);
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Routes that wear the app chrome. Everything else — landing, legal, status — is
 * drawn on the paper palette alone and stays light whatever the preference says.
 */
export const THEMED_ROUTE_PREFIXES = ["/home", "/spaces", "/episodes", "/artifacts", "/people", "/activity", "/developer", "/tenant", "/account", "/space"] as const;

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function readThemePreference(cookie: string): ThemePreference {
  const value = THEME_COOKIE_PATTERN.exec(cookie)?.[1];
  return parseThemePreference(value === undefined ? null : decodeURIComponent(value));
}

export function persistThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.cookie = `${THEME_COOKIE_NAME}=${preference}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
}

export function systemThemeMode(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(SYSTEM_DARK_QUERY).matches ? "dark" : "light";
}

export function watchSystemThemeMode(onChange: (mode: ThemeMode) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};

  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  const handleChange = (event: MediaQueryListEvent) => onChange(event.matches ? "dark" : "light");
  query.addEventListener("change", handleChange);
  return () => query.removeEventListener("change", handleChange);
}

export function isThemedRoute(pathname: string): boolean {
  return THEMED_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function resolveThemeMode({ preference, pathname, systemMode }: { preference: ThemePreference; pathname: string; systemMode: ThemeMode }): ThemeMode {
  if (!isThemedRoute(pathname)) return "light";
  return preference === "system" ? systemMode : preference;
}

/**
 * The one writer of the document theme flags. `dark` drives the app tokens and
 * Tailwind's dark variant; `data-chalk-theme` is what chalk portals read, so
 * writing it on every mode keeps popups from drifting to the OS on their own.
 */
export function applyThemeMode(root: HTMLElement, mode: ThemeMode): void {
  root.classList.toggle("dark", mode === "dark");
  root.setAttribute("data-chalk-theme", mode);
  root.style.colorScheme = mode;
}

/**
 * Runs in `<head>` before first paint so a dark theme never flashes the light
 * palette. It mirrors `resolveThemeMode` and `applyThemeMode`; the tests below
 * pin the two together.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var m=document.cookie.match(${THEME_COOKIE_PATTERN});var p=m?decodeURIComponent(m[1]):"system";if(p!=="light"&&p!=="dark")p="system";var path=location.pathname;var themed=${JSON.stringify(THEMED_ROUTE_PREFIXES)}.some(function(prefix){return path===prefix||path.indexOf(prefix+"/")===0;});var mode=!themed?"light":p==="system"?(window.matchMedia("${SYSTEM_DARK_QUERY}").matches?"dark":"light"):p;var root=document.documentElement;root.classList.toggle("dark",mode==="dark");root.setAttribute("data-chalk-theme",mode);root.style.colorScheme=mode;}catch(error){}})();`;
