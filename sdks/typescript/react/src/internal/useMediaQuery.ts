import { useCallback, useMemo, useSyncExternalStore } from "react";

const serverSnapshot = () => false;

export function useMediaQuery(query: string): boolean {
  const mediaQuery = useMemo(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : undefined), [query]);
  const subscribe = useCallback(
    (notify: () => void) => {
      mediaQuery?.addEventListener("change", notify);
      return () => mediaQuery?.removeEventListener("change", notify);
    },
    [mediaQuery],
  );
  return useSyncExternalStore(subscribe, () => mediaQuery?.matches ?? false, serverSnapshot);
}

export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

export function useIsTablet(): boolean {
  return useMediaQuery("(min-width: 768px) and (max-width: 1023px)");
}

export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

export function usePrefersDarkMode(): boolean {
  return useMediaQuery("(prefers-color-scheme: dark)");
}
