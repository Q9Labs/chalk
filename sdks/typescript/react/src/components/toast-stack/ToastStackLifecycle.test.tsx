// @vitest-environment happy-dom
import { act, useState } from "react";
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
