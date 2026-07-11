import type { TelemetryClient, TelemetryJourney } from "@q9labsai/chalk-client/telemetry";
import { describe, expect, it, vi } from "vitest";
import { installWebTelemetryLifecycle, type WebTelemetryLifecycleTargets } from "./telemetryLifecycle";

describe("installWebTelemetryLifecycle", () => {
  it("flushes while hidden and keeps the journey open until pagehide", () => {
    const { lifecycle, terminal, flush, uninstall } = installTestLifecycle();

    lifecycle.setVisibility("hidden");
    lifecycle.emitVisibilityChange();

    expect(terminal).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith({ keepalive: true });

    lifecycle.setVisibility("visible");
    lifecycle.emitVisibilityChange();
    expect(terminal).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();

    lifecycle.emitPageHide();

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith("succeeded", { result: "page_closed" });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledWith({ keepalive: true });

    uninstall();
    lifecycle.emitPageHide();
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("records page_closed from pagehide before visibility changes", () => {
    const { lifecycle, terminal, flush } = installTestLifecycle();

    lifecycle.emitPageHide();

    expect(terminal).toHaveBeenCalledWith("succeeded", { result: "page_closed" });
    expect(flush).toHaveBeenCalledWith({ keepalive: true });
  });

  it("flushes without terminalizing the journey when pagehide enters bfcache", () => {
    const { lifecycle, terminal, flush } = installTestLifecycle();

    lifecycle.emitPageHide({ persisted: true });

    expect(terminal).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith({ keepalive: true });
  });

  it("keeps the journey active after bfcache pagehide until a later unload", () => {
    const { lifecycle, terminal, flush } = installTestLifecycle();

    lifecycle.emitPageHide({ persisted: true });
    lifecycle.setVisibility("visible");
    lifecycle.emitVisibilityChange();
    lifecycle.emitPageHide();

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith("succeeded", { result: "page_closed" });
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("records page_closed during React cleanup when no browser lifecycle event arrives", () => {
    const { terminal, flush, uninstall } = installTestLifecycle();

    uninstall();

    expect(terminal).toHaveBeenCalledWith("succeeded", { result: "page_closed" });
    expect(flush).toHaveBeenCalledWith({ keepalive: true });
  });
});

function installTestLifecycle() {
  const lifecycle = createLifecycleTargets();
  const terminal = vi.fn();
  const flush = vi.fn(async () => undefined);
  const uninstall = installWebTelemetryLifecycle({ flush } as Pick<TelemetryClient, "flush">, { terminal } as Pick<TelemetryJourney, "terminal">, lifecycle.targets);
  return { lifecycle, terminal, flush, uninstall };
}

function createLifecycleTargets(): {
  readonly targets: WebTelemetryLifecycleTargets;
  emitPageHide(options?: { readonly persisted?: boolean }): void;
  emitVisibilityChange(): void;
  setVisibility(state: DocumentVisibilityState): void;
} {
  const pageHideListeners = new Set<EventListener>();
  const visibilityListeners = new Set<EventListener>();
  let visibilityState: DocumentVisibilityState = "visible";

  return {
    targets: {
      document: {
        get visibilityState() {
          return visibilityState;
        },
        addEventListener: (_type, listener) => visibilityListeners.add(listener),
        removeEventListener: (_type, listener) => visibilityListeners.delete(listener),
      },
      window: {
        addEventListener: (_type, listener) => pageHideListeners.add(listener),
        removeEventListener: (_type, listener) => pageHideListeners.delete(listener),
      },
    },
    emitPageHide({ persisted = false } = {}) {
      const event = new Event("pagehide");
      Object.defineProperty(event, "persisted", { value: persisted });
      for (const listener of pageHideListeners) listener(event);
    },
    emitVisibilityChange() {
      for (const listener of visibilityListeners) listener(new Event("visibilitychange"));
    },
    setVisibility(state) {
      visibilityState = state;
    },
  };
}
