export type ThemePreference = "light" | "dark";
export type ThemeMode = ThemePreference;
const THEME_COOKIE_NAME = "chalk_theme";
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const THEME_COOKIE_PATTERN = /(?:^|;\s*)chalk_theme=([^;]*)/;
export function readThemePreference(cookie: string): ThemePreference {
  return THEME_COOKIE_PATTERN.exec(cookie)?.[1] === "light" ? "light" : "dark";
}
export function persistThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.cookie = `${THEME_COOKIE_NAME}=${preference}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
}
export function resolveThemeMode({ preference, pathname }: { preference: ThemePreference; pathname: string }): ThemeMode {
  return pathname === "/space" || pathname.startsWith("/space/") ? preference : "light";
}
export function applyThemeMode(root: HTMLElement, mode: ThemeMode): void {
  root.classList.toggle("dark", mode === "dark");
  root.setAttribute("data-chalk-theme", mode);
  root.style.colorScheme = mode;
}
/** Runs in head before first paint; keep aligned with resolveThemeMode. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var m=document.cookie.match(${THEME_COOKIE_PATTERN});var p=m&&m[1]==="light"?"light":"dark";var path=location.pathname;var mode=path==="/space"||path.indexOf("/space/")===0?p:"light";var root=document.documentElement;root.classList.toggle("dark",mode==="dark");root.setAttribute("data-chalk-theme",mode);root.style.colorScheme=mode;})();`;
