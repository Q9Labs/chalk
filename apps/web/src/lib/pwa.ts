import type { PwaBuildMeta, PwaInstallPlatform } from "@q9labs/chalk-react";

const THEME_COLORS = {
  dark: "#030303",
  light: "#ffffff",
} as const;
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

export function getPwaInstallPromptContent({ hasNativePrompt, installPlatform, requiresManualInstall }: { hasNativePrompt: boolean; installPlatform: PwaInstallPlatform; requiresManualInstall: boolean }): PwaInstallPromptContent {
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

export function formatPwaBuildLabel(buildMeta: PwaBuildMeta | null) {
  if (!buildMeta) {
    return "Fresh build";
  }

  return `v${buildMeta.version} · ${buildMeta.commitHash.slice(0, 7)}`;
}
