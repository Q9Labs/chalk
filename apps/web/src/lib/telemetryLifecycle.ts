import type { TelemetryClient, TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

interface VisibilityChangeTarget {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: EventListener): void;
  removeEventListener(type: "visibilitychange", listener: EventListener): void;
}

interface PageHideTarget {
  addEventListener(type: "pagehide", listener: EventListener): void;
  removeEventListener(type: "pagehide", listener: EventListener): void;
}

export interface WebTelemetryLifecycleTargets {
  readonly document: VisibilityChangeTarget;
  readonly window: PageHideTarget;
}

/** Records the page journey's terminal state from browser lifecycle signals and delivers it with an unload-safe request. */
export function installWebTelemetryLifecycle(telemetry: Pick<TelemetryClient, "flush">, journey: Pick<TelemetryJourney, "terminal">, targets: WebTelemetryLifecycleTargets = browserTelemetryLifecycleTargets()): () => void {
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    journey.terminal("succeeded", { result: "page_closed" });
    void telemetry.flush({ keepalive: true });
  };
  const onVisibilityChange: EventListener = () => {
    if (targets.document.visibilityState === "hidden") void telemetry.flush({ keepalive: true });
  };
  const onPageHide: EventListener = (event) => {
    if ((event as PageTransitionEvent).persisted) {
      void telemetry.flush({ keepalive: true });
      return;
    }

    close();
  };

  targets.document.addEventListener("visibilitychange", onVisibilityChange);
  targets.window.addEventListener("pagehide", onPageHide);

  return () => {
    targets.document.removeEventListener("visibilitychange", onVisibilityChange);
    targets.window.removeEventListener("pagehide", onPageHide);
    close();
  };
}

function browserTelemetryLifecycleTargets(): WebTelemetryLifecycleTargets {
  return { document, window };
}
