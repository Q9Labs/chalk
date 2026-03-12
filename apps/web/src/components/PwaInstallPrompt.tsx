import { Button } from "@q9labs/chalk-ui";
import { usePwaInstall } from "@q9labs/chalk-react";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { formatPwaBuildLabel, getPwaInstallPromptContent, type PwaBuildMeta, readPwaInstallDismissal, registerPwaServiceWorker, requestPwaBuildMeta, shouldHidePwaPrompt, writePwaInstallDismissal } from "../lib/pwa";

export function PwaInstallPrompt() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { canInstall, hasNativePrompt, installPlatform, isInstalled, promptInstall, requiresManualInstall } = usePwaInstall();
  const [dismissed, setDismissed] = useState(() => readPwaInstallDismissal());
  const [isOfflineReady, setIsOfflineReady] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [waitingBuildMeta, setWaitingBuildMeta] = useState<PwaBuildMeta | null>(null);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleInstalled = () => {
      writePwaInstallDismissal(false);
      setDismissed(false);
    };

    window.addEventListener("appinstalled", handleInstalled);
    return () => window.removeEventListener("appinstalled", handleInstalled);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || import.meta.env.DEV || !("serviceWorker" in navigator)) {
      return;
    }

    let isMounted = true;
    let cleanupRegistrationListener = () => {};
    const cleanupInstallingListeners = new Map<ServiceWorker, () => void>();
    const setWaitingUpdate = (worker: ServiceWorker | null) => {
      if (!isMounted) {
        return;
      }

      setWaitingWorker(worker);
      setWaitingBuildMeta(null);
      setUpdateAvailable(worker !== null);

      if (!worker) {
        return;
      }

      void requestPwaBuildMeta(worker).then((buildMeta) => {
        if (isMounted) {
          setWaitingBuildMeta(buildMeta);
        }
      });
    };

    const attachInstallingListener = (registration: ServiceWorkerRegistration) => {
      const installing = registration.installing;
      if (!installing || cleanupInstallingListeners.has(installing)) {
        return;
      }

      const handleStateChange = () => {
        if (!isMounted || installing.state !== "installed") {
          return;
        }

        if (navigator.serviceWorker.controller) {
          setWaitingUpdate(registration.waiting ?? installing);
          return;
        }

        setIsOfflineReady(true);
      };

      installing.addEventListener("statechange", handleStateChange);
      cleanupInstallingListeners.set(installing, () => {
        installing.removeEventListener("statechange", handleStateChange);
      });
    };

    const handleControllerChange = () => {
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);

    void registerPwaServiceWorker()
      .then((registration) => {
        if (!isMounted || !registration) {
          return;
        }

        attachInstallingListener(registration);

        if (registration.waiting) {
          setWaitingUpdate(registration.waiting);
        }

        const handleUpdateFound = () => {
          attachInstallingListener(registration);
        };

        registration.addEventListener("updatefound", handleUpdateFound);
        cleanupRegistrationListener = () => registration.removeEventListener("updatefound", handleUpdateFound);

        void registration.update().catch(() => {
          // Fail open if eager update checks are blocked.
        });
      })
      .catch(() => {
        // Registration is best effort; the app still works without it.
      });

    return () => {
      isMounted = false;
      cleanupRegistrationListener();
      cleanupInstallingListeners.forEach((cleanup) => cleanup());
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  useEffect(() => {
    if (!isOfflineReady) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsOfflineReady(false);
    }, 4000);

    return () => window.clearTimeout(timeoutId);
  }, [isOfflineReady]);

  useEffect(() => {
    if (!isInstalled) {
      return;
    }

    writePwaInstallDismissal(false);
    setDismissed(false);
  }, [isInstalled]);

  const shouldHide = useMemo(() => shouldHidePwaPrompt(pathname), [pathname]);
  const installPromptContent = useMemo(
    () =>
      getPwaInstallPromptContent({
        hasNativePrompt,
        installPlatform,
        requiresManualInstall,
      }),
    [hasNativePrompt, installPlatform, requiresManualInstall],
  );
  const showUpdatePrompt = updateAvailable && !shouldHide;
  const showInstallPrompt = !showUpdatePrompt && !shouldHide && !isInstalled && !dismissed && canInstall;

  const handleDismiss = () => {
    writePwaInstallDismissal(true);
    setDismissed(true);
  };

  if (showUpdatePrompt) {
    return (
      <aside className="pointer-events-auto fixed bottom-4 left-4 z-50 max-w-sm rounded-2xl border border-border/70 bg-background/95 p-4 text-sm shadow-2xl backdrop-blur-xl">
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="font-display text-base font-semibold text-foreground">Update ready</p>
            <p className="text-muted-foreground">Reload for the newest meeting shell, cached assets, and install polish.</p>
            <p className="text-xs font-medium text-foreground/70">{formatPwaBuildLabel(waitingBuildMeta)}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                waitingWorker?.postMessage({
                  type: "SKIP_WAITING",
                });
              }}
            >
              Reload to update
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setUpdateAvailable(false);
                setWaitingBuildMeta(null);
              }}
            >
              Later
            </Button>
          </div>
        </div>
      </aside>
    );
  }

  if (showInstallPrompt) {
    return (
      <aside className="pointer-events-auto fixed bottom-4 left-4 z-50 max-w-sm rounded-2xl border border-border/70 bg-background/95 p-4 text-sm shadow-2xl backdrop-blur-xl">
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="font-display text-base font-semibold text-foreground">{installPromptContent.title}</p>
            <p className="text-muted-foreground">{installPromptContent.description}</p>
            {installPromptContent.badge && <p className="text-xs font-medium text-foreground/70">{installPromptContent.badge}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hasNativePrompt && installPromptContent.ctaLabel ? (
              <Button
                size="sm"
                onClick={() => {
                  void promptInstall().then((choice) => {
                    if (choice?.outcome === "accepted") {
                      writePwaInstallDismissal(false);
                    }
                  });
                }}
              >
                {installPromptContent.ctaLabel}
              </Button>
            ) : (
              <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">{requiresManualInstall ? "Manual install available" : "Install not available here"}</span>
            )}
            <Button size="sm" variant="ghost" onClick={handleDismiss}>
              {installPromptContent.dismissLabel}
            </Button>
          </div>
        </div>
      </aside>
    );
  }

  if (isOfflineReady && !shouldHide) {
    return <aside className="pointer-events-none fixed bottom-4 left-4 z-50 max-w-sm rounded-2xl border border-border/70 bg-background/90 px-4 py-3 text-sm text-muted-foreground shadow-2xl backdrop-blur-xl">Chalk cached its app shell for quicker relaunches.</aside>;
  }

  return null;
}
