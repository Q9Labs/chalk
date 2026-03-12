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

function supportsManualInstall() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const isAppleDevice = /iphone|ipad|ipod/.test(userAgent) || (/macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);
  const isSafari = /safari/.test(userAgent) && !/crios|fxios|edgios|chrome|android/.test(userAgent);

  return isAppleDevice && isSafari;
}

export function usePwaInstall() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(() => isStandaloneMode());

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
    const requiresManualInstall = !isInstalled && !hasNativePrompt && supportsManualInstall();

    return {
      canInstall: !isInstalled && (hasNativePrompt || requiresManualInstall),
      hasNativePrompt,
      requiresManualInstall,
      isInstalled,
      promptInstall,
    };
  }, [isInstalled, promptEvent, promptInstall]);
}
