// @vitest-environment happy-dom
import { act, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { it, vi, expect } from "vitest";
import { ToastStack } from "./ToastStack";

it("inline callback can report folded ids into host state", async () => {
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  Object.defineProperty(frame, "clientHeight", { get: () => 320 });
  document.body.append(frame);
  const root = createRoot(frame);
  let renders = 0;
  function Host() {
    const [ids, setIds] = useState<readonly string[]>([]);
    renders++;
    if (renders > 30) throw new Error("fold callback render loop");
    return (
      <>
        <output>{ids.join(",")}</output>
        <ToastStack toasts={[{ id: "error", message: "Camera blocked", type: "error" }]} onDismiss={() => {}} onFold={(folded) => setIds([...folded])} />
      </>
    );
  }
  try {
    await act(async () => root.render(<Host />));
    expect(frame.querySelector("output")?.textContent).toBe("error");
  } finally {
    await act(async () => root.unmount());
    frame.remove();
  }
});

it("replacement error survives dismissal of the prior error", async () => {
  vi.useFakeTimers();
  const frame = document.createElement("main");
  document.body.append(frame);
  const root = createRoot(frame);
  const dismiss = vi.fn();
  const fold = () => {};
  const render = async (message: string) => act(async () => root.render(<ToastStack toasts={[{ id: "space-command-error", type: "error", message }]} onDismiss={dismiss} onFold={fold} />));
  try {
    await render("Camera blocked");
    await act(async () => frame.querySelector<HTMLButtonElement>("[data-part=toast-dismiss]")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(80));
    await render("Screen sharing denied");
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(dismiss).not.toHaveBeenCalled();
    expect(frame.querySelector("[data-part=toast]")?.getAttribute("data-exiting")).toBeNull();
    await render("Camera blocked");
    expect(frame.querySelector("[data-part=toast]")?.getAttribute("data-exiting")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(dismiss).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    vi.useRealTimers();
  }
});

it.each([
  { mode: "new-id", nextHeight: 320, nextBand: 200 },
  { mode: "same-id", nextHeight: 320, nextBand: 200 },
  { mode: "same-id", nextHeight: 620, nextBand: 26 },
])("does not start a folded message resource when folding is re-enabled: $mode at $nextHeight with a $nextBand band", async ({ mode, nextHeight, nextBand }) => {
  let callHeight = 844;
  let band = 200;
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? callHeight : band;
  });
  const itemHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(48);
  let mounts = 0;
  let cleanups = 0;
  function Resource() {
    useLayoutEffect(() => {
      mounts++;
      return () => {
        cleanups++;
      };
    }, []);
    return <input aria-label="New message resource" />;
  }
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame);
  const fold = vi.fn();
  const render = (folding: boolean, id: string, message: ReactNode) => act(async () => root.render(<ToastStack toasts={[{ id, message, announcementText: "Notice", duration: Infinity }]} onDismiss={() => {}} onFold={folding ? fold : undefined} />));
  try {
    await render(true, "stable", "Original notice");
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(1);
    await render(false, "stable", "Original notice");
    callHeight = nextHeight;
    band = nextBand;
    await render(false, "stable", "Original notice");
    expect(mounts).toBe(0);
    const nextId = mode === "same-id" ? "stable" : "new";
    await render(true, nextId, <Resource />);
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    expect(fold.mock.calls.at(-1)?.[0]).toEqual([nextId]);
    expect({ mounts, cleanups }).toEqual({ mounts: 0, cleanups: 0 });
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    itemHeight.mockRestore();
  }
});
