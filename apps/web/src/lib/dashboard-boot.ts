/**
 * The dashboard is drawn by script, so until its script and styles arrive the page would be an empty canvas. The
 * dashboard's opening frame fills that wait: plain HTML in the dashboard's own geometry (the top bar, the page head and
 * placeholder rows), written by an inline script at the top of the body, so it is on screen from the first paint. Its
 * styles live in `styles/dashboard-boot.css`, which every page loads. Once the app has drawn and its stylesheets have
 * loaded, the frame fades out over the app's own placeholders and is removed.
 *
 * The head theme script marks a dashboard path with `data-chalk-dashboard` set to the theme, so this script only reads
 * that. Sign-in, Connect and joining a call stand alone without the dashboard's top bar, so they keep the plain canvas.
 */
export const DASHBOARD_BOOT_ID = "chalk-dashboard-boot";

const row = (width: number) => `<div class="bo-row"><span class="bo-fc"><i class="bo-face"></i></span><span class="bo-tx"><i style="width:${width}%"></i></span><i class="bo-m"></i></div>`;
const ROWS = [38, 28, 44, 32].map(row).join("");
const TOP = `<div class="bo-top"><i class="bo-lk"></i><span class="bo-tabs"><i class="on"></i><i></i><i></i></span><i class="bo-docs"></i><i class="bo-av"></i></div>`;
const HOME = `<div class="bo-head"><i class="bo-h1"></i><span class="bo-acts"><i class="bo-btn"></i><i class="bo-field"></i></span></div><div class="bo-list">${ROWS}</div>`;
const PAGE = `<i class="bo-back"></i><div class="bo-head bo-page"><i class="bo-h1"></i><i class="bo-intro"></i></div><div class="bo-list">${ROWS}</div>`;
const frame = (theme: string, body: string) => `<div id="${DASHBOARD_BOOT_ID}" data-chalk="" data-chalk-theme="${theme}" aria-hidden="true">${TOP}<div class="bo-main"><div class="bo-wrap">${body}</div></div></div>`;

/** Runs first in the body. Kept as a string so it needs nothing from the app bundle. */
export const DASHBOARD_BOOT_SCRIPT = `(function(){var t=document.documentElement.getAttribute("data-chalk-dashboard");if(!t)return;var p=location.pathname.replace(/\\/$/,"");var s=document.currentScript;if(!s)return;s.insertAdjacentHTML("beforebegin",p==="/dashboard"?${JSON.stringify(frame("@", HOME))}.replace("@",t):${JSON.stringify(frame("@", PAGE))}.replace("@",t));})();`;

/**
 * Fades the opening frame out once every stylesheet the app added has loaded, so the app is never seen unstyled, then
 * removes it. It waits on the stylesheets' own load events, not on animation frames or timers alone, so a page whose
 * timers are held (a background tab, a test clock) still lets the frame go. Returns a cleanup for the effect that calls it.
 */
export function dismissDashboardBoot(): () => void {
  const boot = document.getElementById(DASHBOARD_BOOT_ID);
  if (!boot) return () => {};
  const pending = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).filter((link) => link.sheet === null);
  let left = pending.length;
  let timer = 0;
  const stopWaiting = () => {
    window.clearTimeout(timer);
    for (const link of pending) {
      link.removeEventListener("load", settle);
      link.removeEventListener("error", settle);
    }
  };
  const leave = () => {
    stopWaiting();
    if (boot.hasAttribute("data-leaving")) return;
    boot.setAttribute("data-leaving", "");
    boot.addEventListener("transitionend", () => boot.remove(), { once: true });
    window.setTimeout(() => boot.remove(), 400);
  };
  function settle() {
    left -= 1;
    if (left <= 0) leave();
  }
  if (left === 0) {
    leave();
    return () => {};
  }
  for (const link of pending) {
    link.addEventListener("load", settle);
    link.addEventListener("error", settle);
  }
  // A stylesheet that never answers can't keep the frame up for good.
  timer = window.setTimeout(leave, 4000);
  return stopWaiting;
}

/** Leaving the dashboard before the frame faded takes it away at once. */
export function removeDashboardBoot(): void {
  document.getElementById(DASHBOARD_BOOT_ID)?.remove();
}
