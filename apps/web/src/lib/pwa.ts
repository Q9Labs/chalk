import type { PwaInstallPlatform } from "@q9labs/chalk-react";

const THEME_COLORS = {
  dark: "#030303",
  light: "#ffffff",
  nord: "#2e3440",
} as const;
const INSTALL_DISMISSAL_KEY = "chalk-pwa-install-dismissed";

export type PwaBuildMeta = {
  commitHash: string;
  version: string;
};

type PwaInstallPromptContent = {
  badge: string | null;
  ctaLabel: string | null;
  description: string;
  dismissLabel: string;
  title: string;
};

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

export function getPwaInstallPromptContent({
  hasNativePrompt,
  installPlatform,
  requiresManualInstall,
}: {
  hasNativePrompt: boolean;
  installPlatform: PwaInstallPlatform;
  requiresManualInstall: boolean;
}): PwaInstallPromptContent {
  if (hasNativePrompt && installPlatform === "android") {
    return {
      badge: "Home screen app",
      ctaLabel: "Add app",
      description: "Keep Chalk one tap away on your home screen and reopen meetings in a focused app shell.",
      dismissLabel: "Later",
      title: "Add Chalk to your home screen",
    };
  }

  if (hasNativePrompt) {
    return {
      badge: "Desktop install",
      ctaLabel: "Install app",
      description: "Launch faster, keep meetings in their own window, and reopen Chalk from your Dock, Start menu, or taskbar.",
      dismissLabel: "Later",
      title: "Install Chalk",
    };
  }

  if (requiresManualInstall && installPlatform === "ios-safari") {
    return {
      badge: "Safari Share -> Add to Home Screen",
      ctaLabel: null,
      description: "In Safari, tap Share and choose Add to Home Screen for one-tap joins and a full-screen meeting shell.",
      dismissLabel: "Got it",
      title: "Add Chalk to Home Screen",
    };
  }

  if (requiresManualInstall && installPlatform === "mac-safari") {
    return {
      badge: "Safari File -> Add to Dock",
      ctaLabel: null,
      description: "In Safari, choose File and then Add to Dock to launch Chalk like a desktop app.",
      dismissLabel: "Got it",
      title: "Add Chalk to your Dock",
    };
  }

  return {
    badge: requiresManualInstall ? "Install from browser menu" : null,
    ctaLabel: null,
    description: "Use your browser install menu to keep Chalk nearby for faster relaunches.",
    dismissLabel: requiresManualInstall ? "Got it" : "Later",
    title: "Install Chalk",
  };
}

function parsePwaBuildMeta(value: unknown): PwaBuildMeta | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PwaBuildMeta>;
  if (typeof candidate.version !== "string" || typeof candidate.commitHash !== "string") {
    return null;
  }

  return {
    commitHash: candidate.commitHash,
    version: candidate.version,
  };
}

export function formatPwaBuildLabel(buildMeta: PwaBuildMeta | null) {
  if (!buildMeta) {
    return "Fresh build";
  }

  return `v${buildMeta.version} · ${buildMeta.commitHash.slice(0, 7)}`;
}

export async function requestPwaBuildMeta(
  worker: Pick<ServiceWorker, "postMessage"> | null,
  timeoutMs = 1500,
) {
  if (!worker || typeof MessageChannel === "undefined") {
    return null;
  }

  return await new Promise<PwaBuildMeta | null>((resolve) => {
    const channel = new MessageChannel();
    const timeoutId = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeoutId);
      channel.port1.close();
      resolve(parsePwaBuildMeta(event.data));
    };

    try {
      worker.postMessage(
        {
          type: "GET_BUILD_META",
        },
        [channel.port2],
      );
    } catch {
      clearTimeout(timeoutId);
      channel.port1.close();
      resolve(null);
    }
  });
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
