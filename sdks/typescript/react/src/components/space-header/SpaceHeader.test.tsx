// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SpaceHeader } from "./SpaceHeader";

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

it.each([
  { call: 300, window: 1024, phone: true },
  { call: 1024, window: 390, phone: false },
])("picks the $call px call's layout in a $window px window", async ({ call, window: width, phone }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === "(max-width: 640px)" ? width <= 640 : false,
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
      observe() {}
      disconnect() {}
    },
  );
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  frame.getBoundingClientRect = () => DOMRect.fromRect({ width: call, height: 320 });
  document.body.append(frame);
  const root = createRoot(frame);
  try {
    await act(async () => root.render(<SpaceHeader spaceName="Narrow call" />));
    expect(frame.querySelector('button[data-part="call-name"]')?.classList.contains("chalk-call-name-phone")).toBe(phone);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
