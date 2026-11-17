import { expect, it, vi } from "vitest";
import { createNativeTelemetryPlatform } from "./native-telemetry-platform";

function fakeAppState(currentState: string) {
  const listeners = new Set<(state: string) => void>();
  const appState = {
    currentState,
    addEventListener: (_type: "change", listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: () => void listeners.delete(listener) };
    },
  };
  return { appState, emit: (state: string) => listeners.forEach((listener) => listener(state)), listeners };
}

it("tells the outbox about the background and the foreground, and nothing about inactive", () => {
  const app = fakeAppState("active");
  const platform = createNativeTelemetryPlatform({ appState: app.appState, fetch: vi.fn<typeof globalThis.fetch>() });
  const changes: string[] = [];
  const unsubscribe = platform.subscribe((change) => changes.push(change));
  for (const state of ["inactive", "background", "inactive", "active"]) app.emit(state);
  expect(changes).toEqual(["background", "foreground"]);
  unsubscribe();
  expect(app.listeners.size).toBe(0);
});

it("never touches window, so a Hermes runtime without window.addEventListener is no problem", () => {
  vi.stubGlobal("window", {});
  const app = fakeAppState("background");
  const platform = createNativeTelemetryPlatform({ appState: app.appState, fetch: vi.fn<typeof globalThis.fetch>() });
  expect(() => platform.subscribe(() => undefined)()).not.toThrow();
  expect(platform.hidden()).toBe(true);
  vi.unstubAllGlobals();
});
