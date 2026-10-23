// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
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

it.each(["equivalent JSX", "band resize", "another notice", "initial band smaller than any toast"])("does not mount a known folded caller tree to refit after %s", async (change) => {
  let bandHeight = change === "initial band smaller than any toast" ? 26 : 60;
  const notifications = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private notify: () => void) {}
      observe() {
        notifications.add(this.notify);
      }
      disconnect() {
        notifications.delete(this.notify);
      }
    },
  );
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? 844 : bandHeight;
  });
  const childHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  let mounts = 0;
  function Message() {
    useLayoutEffect(() => {
      mounts += 1;
    }, []);
    return <span>Camera blocked</span>;
  }
  function Icon() {
    return <svg width="20" height="20" />;
  }
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame);
  const render = () => act(async () => root.render(<ToastStack toasts={[{ id: "same", message: <Message />, icon: <Icon /> }]} onDismiss={() => {}} onFold={() => {}} />));
  try {
    await render();
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    const before = mounts;
    if (change === "initial band smaller than any toast") expect(mounts).toBe(0);
    else if (change === "equivalent JSX") await render();
    else if (change === "another notice") {
      await act(async () =>
        root.render(
          <ToastStack
            toasts={[
              { id: "same", message: <Message />, icon: <Icon /> },
              { id: "new", message: "New notice" },
            ]}
            maxVisible={3}
            onDismiss={() => {}}
            onFold={() => {}}
          />,
        ),
      );
    } else {
      bandHeight = 65;
      await act(async () => {
        for (const notify of [...notifications]) notify();
      });
    }
    expect(mounts).toBe(before);
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    childHeight.mockRestore();
    vi.unstubAllGlobals();
  }
});
