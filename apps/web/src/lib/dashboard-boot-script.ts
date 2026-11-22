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
const HEAD_HOME = `<div class="bo-head"><i class="bo-h1"></i><span class="bo-acts"><i class="bo-btn"></i><i class="bo-field"></i></span></div>`;
const HEAD_PAGE = `<i class="bo-back"></i><div class="bo-head bo-page"><i class="bo-h1"></i><i class="bo-intro"></i></div>`;
const OPEN = `<div id="${DASHBOARD_BOOT_ID}" data-chalk="" data-chalk-theme="`;
const MAIN = `" aria-hidden="true">${TOP}<div class="bo-main"><div class="bo-wrap">`;
const CLOSE = `<div class="bo-list">${ROWS}</div></div></div></div>`;

/** Runs first in the body. Kept as a string so it needs nothing from the app bundle. */
export const DASHBOARD_BOOT_SCRIPT = `(function(){var t=document.documentElement.getAttribute("data-chalk-dashboard");var s=document.currentScript;if(!t||!s)return;s.insertAdjacentHTML("beforebegin",${JSON.stringify(OPEN)}+t+${JSON.stringify(MAIN)}+(location.pathname.replace(/\\/$/,"")==="/dashboard"?${JSON.stringify(HEAD_HOME)}:${JSON.stringify(HEAD_PAGE)})+${JSON.stringify(CLOSE)});})();`;
