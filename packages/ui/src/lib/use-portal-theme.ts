"use client";

import { useSyncExternalStore } from "react";

import { resolvePortalThemeFromDocument, type ThemeMode } from "./theme";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
const WATCHED_ATTRIBUTES = ["class", "data-chalk-theme", "data-theme"] as const;

/**
 * Portals live outside the themed subtree, so they read the theme off the
 * document instead of inheriting it. Reading it once at mount left popups on
 * the old palette whenever the host app flipped the theme underneath them, so
 * the read is a subscription: the host writes the attribute, the popup follows.
 */
function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};

  const observer = new MutationObserver(onChange);
  const options: MutationObserverInit = { attributes: true, attributeFilter: [...WATCHED_ATTRIBUTES] };
  observer.observe(document.documentElement, options);
  if (document.body) observer.observe(document.body, options);

  const media = typeof window.matchMedia === "function" ? window.matchMedia(SYSTEM_DARK_QUERY) : null;
  media?.addEventListener("change", onChange);

  return () => {
    observer.disconnect();
    media?.removeEventListener("change", onChange);
  };
}

export function usePortalTheme(defaultTheme: ThemeMode = "light"): ThemeMode {
  const read = () => resolvePortalThemeFromDocument({ defaultTheme });
  return useSyncExternalStore(subscribe, read, () => defaultTheme);
}
