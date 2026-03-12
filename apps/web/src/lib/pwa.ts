const THEME_COLORS = {
  dark: "#030303",
  light: "#ffffff",
  nord: "#2e3440",
} as const;
const INSTALL_DISMISSAL_KEY = "chalk-pwa-install-dismissed";

export function getThemeColor(theme: string | null | undefined) {
  if (theme === "light") {
    return THEME_COLORS.light;
  }

  if (theme === "nord") {
    return THEME_COLORS.nord;
  }

  return THEME_COLORS.dark;
}

export function syncThemeColor(theme: string) {
  if (typeof document === "undefined") {
    return;
  }

  const color = getThemeColor(theme);

  for (const metaTag of document.querySelectorAll('meta[name="theme-color"]')) {
    metaTag.setAttribute("content", color);
  }
}

export function shouldHidePwaPrompt(pathname: string) {
  return pathname.startsWith("/room/") || pathname.startsWith("/share/") || pathname.startsWith("/j/") || pathname.startsWith("/auth/");
}

export function readPwaInstallDismissal() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(INSTALL_DISMISSAL_KEY) === "1";
  } catch {
    return false;
  }
}

export function writePwaInstallDismissal(dismissed: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (dismissed) {
      window.localStorage.setItem(INSTALL_DISMISSAL_KEY, "1");
      return;
    }

    window.localStorage.removeItem(INSTALL_DISMISSAL_KEY);
  } catch {
    // Ignore storage failures and fail open.
  }
}

export async function registerPwaServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    return await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(__COMMIT_HASH__)}`, {
      scope: "/",
    });
  } catch (error) {
    console.warn("[chalk:web] Failed to register service worker.", error);
    return null;
  }
}
