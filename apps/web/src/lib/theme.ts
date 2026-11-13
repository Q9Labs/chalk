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
const CALL_JOIN_PATH_PATTERN = /^\/dashboard\/call\/[^/]+\/join\/?$/;
/**
 * Runs in head before first paint; keep aligned with resolveThemeMode. On a dashboard page inside the top bar it also
 * marks the root with the dashboard's theme, which the opening frame (lib/dashboard-boot.ts) reads. Call routes also get
 * data-call-boot, set to the call's theme (the cookie's, even on the dashboard join route), for CALL_BOOT_CSS.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var m=document.cookie.match(${THEME_COOKIE_PATTERN});var p=m&&m[1]==="light"?"light":"dark";var path=location.pathname;var space=path==="/space"||path.indexOf("/space/")===0||${INVITE_CODE_PATH_PATTERN}.test(path);var mode=space?p:"light";var root=document.documentElement;root.classList.toggle("dark",mode==="dark");root.setAttribute("data-chalk-theme",mode);root.style.colorScheme=mode;if(path==="/dashboard"||path.indexOf("/dashboard/")===0){var c=p==="light"?"${DASHBOARD_CANVAS.light}":"${DASHBOARD_CANVAS.dark}";var s=document.createElement("style");s.id="${DASHBOARD_CANVAS_STYLE_ID}";s.textContent="html,body{background:"+c+"}";document.head.appendChild(s);if(!/^\\/dashboard\\/(sign-in|connect)(\\/|$)|^\\/dashboard\\/call\\/[^/]+\\/join\\/?$/.test(path))root.setAttribute("data-chalk-dashboard",p);}if(space||${CALL_JOIN_PATH_PATTERN}.test(path))root.setAttribute("data-call-boot",p);})();`;
/**
 * The HTML shell of a call route has an empty body until the app loads. This paints the call canvas and the centred
 * joining card (a spinner, since the call's name is not known yet) from the first frame, and steps aside as soon as the
 * app mounts anything of the call. Values mirror the call tokens in packages/ui.
 */
export const CALL_BOOT_CSS = `html[data-call-boot],html[data-call-boot] body{background:#000;}
html[data-call-boot="light"],html[data-call-boot="light"] body{background:#f3f3f5;}
html[data-call-boot] body:not(:has([data-chalk]))::before{content:"";position:fixed;left:50%;top:50%;width:76px;height:68px;transform:translate(-50%,-50%);border-radius:16px;background:#060606;box-shadow:inset 0 0 0 1px rgba(255,255,255,.045);}
html[data-call-boot="light"] body:not(:has([data-chalk]))::before{background:#fff;box-shadow:inset 0 0 0 1px rgba(0,0,0,.09);}
html[data-call-boot] body:not(:has([data-chalk]))::after{content:"";position:fixed;left:50%;top:50%;width:20px;height:20px;margin:-12px 0 0 -12px;border-radius:50%;border:2px solid rgba(255,255,255,.18);border-top-color:#ececee;animation:chalk-boot-spin .8s linear infinite;}
html[data-call-boot="light"] body:not(:has([data-chalk]))::after{border-color:rgba(0,0,0,.14);border-top-color:#18181b;}
@keyframes chalk-boot-spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion: reduce){html[data-call-boot] body::after{animation-duration:2.4s;}}`;
