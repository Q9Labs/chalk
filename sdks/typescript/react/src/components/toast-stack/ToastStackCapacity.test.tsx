// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, vi, expect } from "vitest";
import { ToastStack } from "./ToastStack";

it("remeasures full candidates after a short call becomes a larger tall call", async () => {
  let callHeight = 620;
  let bandHeight = 120;
  const notifications = new Map<ResizeObserver, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private notify: () => void) {}
      observe() {
        notifications.set(this as unknown as ResizeObserver, this.notify);
      }
      disconnect() {
        notifications.delete(this as unknown as ResizeObserver);
      }
    },
  );
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? callHeight : bandHeight;
  });
  const childHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame);
  const toasts = [1, 2, 3].map((n) => ({ id: String(n), message: `Notice ${n}` }));
  const shown = () => frame.querySelectorAll("[data-part=toast]").length;
  try {
    await act(async () => root.render(<ToastStack toasts={toasts} onDismiss={() => {}} onFold={() => {}} />));
    expect(shown()).toBe(1);
    callHeight = 390;
    bandHeight = 20;
    await act(async () => {
      for (const notify of [...notifications.values()]) notify();
    });
    expect(shown()).toBe(0);
    callHeight = 844;
    bandHeight = 500;
    await act(async () => {
      for (const notify of [...notifications.values()]) notify();
    });
    expect(shown()).toBe(3);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    childHeight.mockRestore();
    vi.unstubAllGlobals();
  }
});
