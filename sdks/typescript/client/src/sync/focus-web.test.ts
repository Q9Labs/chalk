import { describe, expect, it, vi } from "vitest";
import { observeWebFocus, type FocusReport, type WebFocusEnvironment } from "./focus-web";

type Listener = () => void;
function environment(input?: { readonly hidden?: boolean; readonly focused?: boolean; readonly sharing?: boolean; readonly pip?: boolean }) {
  const listeners = new Map<string, Set<Listener>>();
  const state = { hidden: input?.hidden ?? false, focused: input?.focused ?? true, sharing: input?.sharing ?? false, pip: input?.pip ?? false };
  const add = (target: Map<string, Set<Listener>>, name: string, listener: Listener) => {
    if (!target.has(name)) target.set(name, new Set());
    target.get(name)?.add(listener);
  };
  const documentListeners = new Map<string, Set<Listener>>();
  const windowListeners = listeners;
  const environment: WebFocusEnvironment = {
    document: {
      get visibilityState() { return state.hidden ? "hidden" : "visible"; },
      hasFocus: () => state.focused,
      get pictureInPictureElement() { return state.pip ? ({ } as Element) : null; },
      addEventListener: (name: string, listener: Listener) => add(documentListeners, name, listener),
      removeEventListener: (name: string, listener: Listener) => documentListeners.get(name)?.delete(listener),
    } as WebFocusEnvironment["document"],
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      screen: { width: 1440, height: 900 },
      addEventListener: (name: string, listener: Listener) => add(windowListeners, name, listener),
      removeEventListener: (name: string, listener: Listener) => windowListeners.get(name)?.delete(listener),
    } as WebFocusEnvironment["window"],
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    isScreenSharing: () => state.sharing,
  };
  return { environment, state, fireDocument: (name: string) => documentListeners.get(name)?.forEach((listener) => listener()), fireWindow: (name: string) => windowListeners.get(name)?.forEach((listener) => listener()) };
}

describe("observeWebFocus", () => {
  it("reports the initial state immediately and debounces a hidden tab for two seconds", () => {
    vi.useFakeTimers();
    const reports: FocusReport[] = [];
    const fixture = environment();
    const stop = observeWebFocus(fixture.environment, (report) => reports.push(report));
    expect(reports).toEqual([{ state: "active", windowed: false }]);
    fixture.state.hidden = true;
    fixture.fireDocument("visibilitychange");
    vi.advanceTimersByTime(1999);
    expect(reports).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(reports.at(-1)).toEqual({ state: "background", windowed: false });
    stop();
    vi.useRealTimers();
  });

  it("cancels a quick switch inside the grace period", () => {
    vi.useFakeTimers();
    const reports: FocusReport[] = [];
    const fixture = environment();
    const stop = observeWebFocus(fixture.environment, (report) => reports.push(report));
    fixture.state.focused = false;
    fixture.fireWindow("blur");
    vi.advanceTimersByTime(1000);
    fixture.state.focused = true;
    fixture.fireWindow("focus");
    vi.advanceTimersByTime(3000);
    expect(reports).toEqual([{ state: "active", windowed: false }]);
    stop();
    vi.useRealTimers();
  });

  it("keeps screen sharing and picture-in-picture active", () => {
    vi.useFakeTimers();
    const reports: FocusReport[] = [];
    const fixture = environment({ sharing: true });
    const stop = observeWebFocus(fixture.environment, (report) => reports.push(report));
    fixture.state.hidden = true;
    fixture.fireDocument("visibilitychange");
    vi.advanceTimersByTime(3000);
    expect(reports).toEqual([{ state: "active", windowed: false }]);
    stop();
    vi.useRealTimers();
  });
});
