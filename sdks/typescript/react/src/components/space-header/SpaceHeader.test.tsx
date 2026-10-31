// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SpaceHeader } from "./SpaceHeader";
import { SpacePresentation } from "../space-view/SpacePresentation";

it.each([
  { variant: "desktop", phone: false },
  { variant: "phone", phone: true },
])("shows the full call name in the $variant trigger title", async ({ phone }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === "(max-width: 640px)" ? phone : !phone && query === "(pointer:fine)",
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const spaceName = "Physics – Grade 9 with a very long list of participants";
  try {
    await act(async () => root.render(<SpaceHeader spaceName={spaceName} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[data-part="call-name"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.classList.contains("chalk-call-name-phone")).toBe(phone);
    expect(trigger?.title).toBe(spaceName);
    expect(trigger?.getAttribute("aria-label")).toBe("Call details");
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(spaceName);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("renders the phone header for a narrow call in a wide window, measuring the call's content box", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly #notify: ResizeObserverCallback;
      constructor(notify: ResizeObserverCallback) {
        this.#notify = notify;
      }
      observe(target: Element) {
        // A 642px frame with a 2px border on each side has a 638px content box.
        target.getBoundingClientRect = () => DOMRect.fromRect({ width: 642, height: 320 });
        this.#notify([{ target, contentRect: DOMRect.fromRect({ width: 638, height: 316 }) } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SpacePresentation stageBackground={false} header={{ spaceName: "Narrow call" }} stage={null} controls={null} />));
    expect(container.querySelector('button[data-part="call-name"]')?.classList.contains("chalk-call-name-phone")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
