import { useCallback, useEffect, useMemo, useState } from "react";

type BeforeInstallPromptChoice = {
  outcome: "accepted" | "dismissed";
  platform: string;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<BeforeInstallPromptChoice>;
};

const DISPLAY_MODE_QUERY = "(display-mode: standalone)";

export type PwaInstallPlatform = "android" | "desktop" | "ios-safari" | "mac-safari" | "unknown";

function subscribeToDisplayModeChanges(mediaQuery: MediaQueryList | undefined, onChange: () => void) {
  if (!mediaQuery) {
    return () => {};
  }

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }

  mediaQuery.addListener(onChange);
  return () => mediaQuery.removeListener(onChange);
}

function isStandaloneMode() {
  if (typeof window === "undefined") {
    return false;
  }

  return (window.matchMedia?.(DISPLAY_MODE_QUERY).matches ?? false) || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function getInstallPlatform(): PwaInstallPlatform {
  if (typeof navigator === "undefined") {
    return "unknown";
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const maxTouchPoints = navigator.maxTouchPoints ?? 0;
  const isAppleTouchDevice = /iphone|ipad|ipod/.test(userAgent) || (/macintosh/.test(userAgent) && maxTouchPoints > 1);
  const isMacDesktop = /macintosh/.test(userAgent) && maxTouchPoints <= 1;
  const isSafari = /safari/.test(userAgent) && !/crios|fxios|edgios|chrome|android/.test(userAgent);

  if (isAppleTouchDevice && isSafari) {
    return "ios-safari";
  }

  if (isMacDesktop && isSafari) {
    return "mac-safari";
  }

  if (/android/.test(userAgent)) {
    return "android";
  }

  if (/macintosh|windows|linux|x11/.test(userAgent)) {
    return "desktop";
  }

  return "unknown";
}

function supportsManualInstall(platform: PwaInstallPlatform) {
  return platform === "ios-safari" || platform === "mac-safari";
}

export function usePwaInstall() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(() => isStandaloneMode());
  const installPlatform = useMemo(() => getInstallPlatform(), []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia?.(DISPLAY_MODE_QUERY);
    const syncInstalledState = () => {
      setIsInstalled(isStandaloneMode());
    };

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setPromptEvent(null);
      setIsInstalled(true);
    };

    syncInstalledState();

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt as EventListener);
    window.addEventListener("appinstalled", handleAppInstalled);
    const unsubscribeDisplayMode = subscribeToDisplayModeChanges(mediaQuery, syncInstalledState);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt as EventListener);
      window.removeEventListener("appinstalled", handleAppInstalled);
      unsubscribeDisplayMode();
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!promptEvent) {
      return null;
    }

    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;

    if (choice.outcome === "accepted") {
      setPromptEvent(null);
      setIsInstalled(true);
    }

    return choice;
  }, [promptEvent]);

  return useMemo(() => {
    const hasNativePrompt = promptEvent !== null;
    const requiresManualInstall = !isInstalled && !hasNativePrompt && supportsManualInstall(installPlatform);

    return {
      canInstall: !isInstalled && (hasNativePrompt || requiresManualInstall),
      hasNativePrompt,
      installPlatform,
      requiresManualInstall,
      isInstalled,
      promptInstall,
    };
  }, [installPlatform, isInstalled, promptEvent, promptInstall]);
}
