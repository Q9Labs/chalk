export type ThemePreference = "light" | "dark";
/** The theme a page is drawn in, which differs from the visitor's preference on pages that are always light. */
export type ResolvedTheme = "light" | "dark";
const INVITE_CODE_PATH_PATTERN = /^\/[a-z]+(?:-[a-z]+){2,3}$/;
export const THEME_COOKIE_NAME = "chalk_theme";
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const THEME_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${THEME_COOKIE_NAME}=([^;]*)`);
export function readThemePreference(cookie: string): ThemePreference {
  return THEME_COOKIE_PATTERN.exec(cookie)?.[1] === "light" ? "light" : "dark";
}
export function persistThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.cookie = `${THEME_COOKIE_NAME}=${preference}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
}
export function resolveTheme({ preference, pathname }: { preference: ThemePreference; pathname: string }): ResolvedTheme {
  return pathname === "/space" || pathname.startsWith("/space/") || INVITE_CODE_PATH_PATTERN.test(pathname) ? preference : "light";
}
export function applyTheme(root: HTMLElement, mode: ResolvedTheme): void {
  root.classList.toggle("dark", mode === "dark");
  root.setAttribute("data-chalk-theme", mode);
  root.style.colorScheme = mode;
}
/** Runs in head before first paint; keep aligned with resolveTheme. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var m=document.cookie.match(${THEME_COOKIE_PATTERN});var p=m&&m[1]==="light"?"light":"dark";var path=location.pathname;var mode=path==="/space"||path.indexOf("/space/")===0||${INVITE_CODE_PATH_PATTERN}.test(path)?p:"light";var root=document.documentElement;root.classList.toggle("dark",mode==="dark");root.setAttribute("data-chalk-theme",mode);root.style.colorScheme=mode;})();`;
