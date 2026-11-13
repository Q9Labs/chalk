export type ThemePreference = "light" | "dark";
export type ThemeMode = ThemePreference;
const INVITE_CODE_PATH_PATTERN = /^\/[a-z]+(?:-[a-z]+){2,3}$/;
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
  return pathname === "/space" || pathname.startsWith("/space/") || INVITE_CODE_PATH_PATTERN.test(pathname) ? preference : "light";
}
export function applyThemeMode(root: HTMLElement, mode: ThemeMode): void {
  root.classList.toggle("dark", mode === "dark");
  root.setAttribute("data-chalk-theme", mode);
  root.style.colorScheme = mode;
}
/**
 * The dashboard is drawn by script, so until it mounts the page shows the body's own colour. Painting the dashboard's
 * canvas from the theme cookie before first paint keeps that wait the colour the page opens in, never a cream flash.
 */
const DASHBOARD_CANVAS = { dark: "#000000", light: "#f3f3f5" } as const;
export const DASHBOARD_CANVAS_STYLE_ID = "chalk-dashboard-canvas";
export const isDashboardPath = (pathname: string) => pathname === "/dashboard" || pathname.startsWith("/dashboard/");
/**
 * Runs in head before first paint; keep aligned with resolveThemeMode. On a dashboard page inside the top bar it also
 * marks the root with the dashboard's theme, which the opening frame (lib/dashboard-boot.ts) reads.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var m=document.cookie.match(${THEME_COOKIE_PATTERN});var p=m&&m[1]==="light"?"light":"dark";var path=location.pathname;var mode=path==="/space"||path.indexOf("/space/")===0||${INVITE_CODE_PATH_PATTERN}.test(path)?p:"light";var root=document.documentElement;root.classList.toggle("dark",mode==="dark");root.setAttribute("data-chalk-theme",mode);root.style.colorScheme=mode;if(path==="/dashboard"||path.indexOf("/dashboard/")===0){var c=p==="light"?"${DASHBOARD_CANVAS.light}":"${DASHBOARD_CANVAS.dark}";var s=document.createElement("style");s.id="${DASHBOARD_CANVAS_STYLE_ID}";s.textContent="html,body{background:"+c+"}";document.head.appendChild(s);if(!/^\\/dashboard\\/(sign-in|connect)(\\/|$)|^\\/dashboard\\/call\\/[^/]+\\/join\\/?$/.test(path))root.setAttribute("data-chalk-dashboard",p);}})();`;
