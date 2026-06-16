import { Button } from "@q9labs/chalk-ui";
import { usePwaInstall, usePwaLifecycle } from "@q9labs/chalk-react";
import { useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { formatPwaBuildLabel, getPwaInstallPromptContent, shouldHidePwaPrompt } from "../lib/pwa";

export function PwaInstallPrompt() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { canInstall, hasNativePrompt, installPlatform, isInstalled, promptInstall, requiresManualInstall } = usePwaInstall();
  const { dismissUpdate, dismissed, isOfflineReady, reloadToUpdate, setDismissed, updateAvailable, waitingBuildMeta } = usePwaLifecycle({
    enabled: !import.meta.env.DEV,
    isInstalled,
    serviceWorkerPath: "/sw.js",
    versionTag: __COMMIT_HASH__,
  });

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
            <Button size="sm" onClick={reloadToUpdate}>
              Reload to update
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissUpdate}>
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
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hasNativePrompt && installPromptContent.ctaLabel ? (
              <Button
                size="sm"
                onClick={() => {
                  void promptInstall().then((choice) => {
                    if (choice?.outcome === "accepted") {
                      setDismissed(false);
                    }
                  });
                }}
              >
                {installPromptContent.ctaLabel}
              </Button>
            ) : (
              <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">{installPromptContent.badge ?? "Install not available here"}</span>
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
