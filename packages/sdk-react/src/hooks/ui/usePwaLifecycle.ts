import { useCallback, useEffect, useMemo, useState } from "react";

export interface PwaBuildMeta {
  commitHash: string;
  version: string;
}

export interface UsePwaLifecycleOptions {
  buildMetaTimeoutMs?: number;
  dismissalKey?: string;
  enabled?: boolean;
  isInstalled?: boolean;
  offlineReadyDurationMs?: number;
  serviceWorkerPath?: string;
  versionTag?: string;
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

async function requestPwaBuildMeta(worker: Pick<ServiceWorker, "postMessage"> | null, timeoutMs: number): Promise<PwaBuildMeta | null> {
  if (!worker || typeof MessageChannel === "undefined") {
    return null;
  }

  return await new Promise<PwaBuildMeta | null>((resolve) => {
    const channel = new MessageChannel();
    const timeoutId = window.setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);

    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeoutId);
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
      window.clearTimeout(timeoutId);
      channel.port1.close();
      resolve(null);
    }
  });
}

function readDismissedFlag(dismissalKey: string) {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(dismissalKey) === "1";
  } catch {
    return false;
  }
}

function writeDismissedFlag(dismissalKey: string, dismissed: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (dismissed) {
      window.localStorage.setItem(dismissalKey, "1");
      return;
    }

    window.localStorage.removeItem(dismissalKey);
  } catch {
    // Ignore storage failures and fail open.
  }
}

export function usePwaLifecycle({
  buildMetaTimeoutMs = 1500,
  dismissalKey = "chalk-pwa-install-dismissed",
  enabled = true,
  isInstalled = false,
  offlineReadyDurationMs = 4000,
  serviceWorkerPath = "/sw.js",
  versionTag,
}: UsePwaLifecycleOptions = {}) {
  const [dismissed, setDismissedState] = useState(() => readDismissedFlag(dismissalKey));
  const [isOfflineReady, setIsOfflineReady] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [waitingBuildMeta, setWaitingBuildMeta] = useState<PwaBuildMeta | null>(null);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  const setDismissed = useCallback(
    (nextDismissed: boolean) => {
      writeDismissedFlag(dismissalKey, nextDismissed);
      setDismissedState(nextDismissed);
    },
    [dismissalKey],
  );

  useEffect(() => {
    if (!isInstalled) {
      return;
    }

    setDismissed(false);
  }, [isInstalled, setDismissed]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !("serviceWorker" in navigator)) {
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

      void requestPwaBuildMeta(worker, buildMetaTimeoutMs).then((buildMeta) => {
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

    void navigator.serviceWorker
      .register(versionTag ? `${serviceWorkerPath}?v=${encodeURIComponent(versionTag)}` : serviceWorkerPath, {
        scope: "/",
      })
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
          // Best effort only.
        });
      })
      .catch((error) => {
        console.warn("[chalk:pwa] Failed to register service worker.", error);
      });

    return () => {
      isMounted = false;
      cleanupRegistrationListener();
      cleanupInstallingListeners.forEach((cleanup) => cleanup());
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, [buildMetaTimeoutMs, enabled, serviceWorkerPath, versionTag]);

  useEffect(() => {
    if (!isOfflineReady) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsOfflineReady(false);
    }, offlineReadyDurationMs);

    return () => window.clearTimeout(timeoutId);
  }, [isOfflineReady, offlineReadyDurationMs]);

  const dismissUpdate = useCallback(() => {
    setUpdateAvailable(false);
    setWaitingBuildMeta(null);
  }, []);

  const reloadToUpdate = useCallback(() => {
    waitingWorker?.postMessage({
      type: "SKIP_WAITING",
    });
  }, [waitingWorker]);

  return useMemo(
    () => ({
      dismissUpdate,
      dismissed,
      isOfflineReady,
      reloadToUpdate,
      setDismissed,
      updateAvailable,
      waitingBuildMeta,
      waitingWorker,
    }),
    [dismissUpdate, dismissed, isOfflineReady, reloadToUpdate, setDismissed, updateAvailable, waitingBuildMeta, waitingWorker],
  );
}
