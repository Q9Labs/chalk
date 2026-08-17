import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/** Environments without `matchMedia` — jsdom among them — resolve to the desktop layout. */
function matchMobileQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_QUERY) : null;
}

/**
 * Tracks whether the viewport is narrower than the `md` breakpoint, so layouts
 * can swap a persistent panel for a drawer. Returns `false` until mounted, which
 * keeps the first client render aligned with server-rendered markup.
 */
export function useIsMobile(): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const query = matchMobileQuery();
    query?.addEventListener("change", onChange);
    return () => query?.removeEventListener("change", onChange);
  }, []);

  return React.useSyncExternalStore(
    subscribe,
    () => matchMobileQuery()?.matches ?? false,
    () => false,
  );
}
