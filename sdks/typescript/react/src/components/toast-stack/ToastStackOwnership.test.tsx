// @vitest-environment happy-dom
import { act, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ToastStack } from "./ToastStack";
import { NoticeButton } from "./NoticeButton";

it.each(["grow", "disable folding"])("does not duplicate a header notice's caller tree when returning to the stage: %s", async (change) => {
  let callHeight = 844;
  const notifications = new Set<(entries: readonly ResizeObserverEntry[]) => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private notify: (entries: readonly ResizeObserverEntry[]) => void) {}
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
    return this.dataset.part === "call-frame" ? callHeight : 200;
  });
  const childHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  let live = 0,
    peak = 0;
  function Resource() {
    useLayoutEffect(() => {
      live += 1;
      peak = Math.max(peak, live);
      return () => {
        live -= 1;
      };
    }, []);
    return <span data-resource>Camera blocked</span>;
  }
  const toasts = [{ id: "same", message: <Resource />, announcementText: "Camera blocked" }];
  function Host({ folding }: { readonly folding: boolean }) {
    const [folded, setFolded] = useState<readonly string[]>([]);
    return (
      <>
        <NoticeButton toasts={toasts.filter((toast) => folded.includes(toast.id))} onDismiss={() => {}} />
        <ToastStack toasts={toasts} onDismiss={() => {}} onFold={folding ? setFolded : undefined} />
      </>
    );
  }
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame);
  try {
    await act(async () => root.render(<Host folding />));
    expect(live).toBe(1);
    callHeight = 320;
    await act(async () => {
      for (const notify of [...notifications]) notify([]);
    });
    await act(async () => frame.querySelector<HTMLButtonElement>("[data-part=notice-button]")?.click());
    expect(document.querySelectorAll("[data-part=notice] [data-resource]")).toHaveLength(1);
    expect(live).toBe(1);
    if (change === "grow") {
      callHeight = 844;
      await act(async () => {
        for (const notify of [...notifications]) notify([]);
      });
    } else await act(async () => root.render(<Host folding={false} />));
    expect(frame.querySelectorAll("[data-part=toast] [data-resource]")).toHaveLength(1);
    expect(live).toBe(1);
    expect(peak).toBe(1);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    childHeight.mockRestore();
    vi.unstubAllGlobals();
  }
  expect(live).toBe(0);
});
