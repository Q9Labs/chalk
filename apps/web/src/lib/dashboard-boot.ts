/**
 * Fades the opening frame out once every stylesheet the app added has loaded, so the app is never seen unstyled, then
 * removes it. It waits on the stylesheets' own load events, not on animation frames or timers alone, so a page whose
 * timers are held (a background tab, a test clock) still lets the frame go. `onGone` runs once the frame is gone, or at
 * once when there is none (`boot` is null). Returns a cleanup for the effect that calls it.
 */
export function dismissDashboardBoot(boot: HTMLElement | null, onGone: () => void): () => void {
  if (!boot) {
    onGone();
    return () => {};
  }
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
    let removed = false;
    const gone = () => {
      if (removed) return;
      removed = true;
      boot.remove();
      onGone();
    };
    boot.addEventListener("transitionend", gone, { once: true });
    window.setTimeout(gone, 400);
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
