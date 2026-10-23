// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { ToastStack } from "./ToastStack";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { SpaceView } from "../space-view/SpaceView";
it("refits a folded toast when its action is removed", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? 844 : 60;
  });
  const child = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.querySelector("button") ? 80 : 48;
  });
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame),
    fold = vi.fn();
  const render = (action: boolean, message = "Camera permission needs attention") => act(async () => root.render(<ToastStack toasts={[{ id: "same", message, action: action ? { label: "Retry", onClick: () => {} } : undefined }]} onDismiss={() => {}} onFold={fold} />));
  try {
    await render(true);
    const before = frame.querySelectorAll("[data-part=toast]").length;
    await render(false);
    const after = frame.querySelectorAll("[data-part=toast]").length;
    await render(false, "Changed camera permission message");
    const control = frame.querySelectorAll("[data-part=toast]").length;
    console.log("CHROME_REPRO", JSON.stringify({ before, afterActionRemoved: after, afterMessageChanged: control, folded: fold.mock.calls }));
    expect(before).toBe(0);
    expect(control).toBe(1);
    expect(after).toBe(1);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    child.mockRestore();
  }
});
it("folds the actual offline warning with other SpaceView notices on a short call", async () => {
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  const base = createSnapshot([]),
    warning = "Your expired offline actions were not sent. Actions are kept for up to 24 hours.";
  const client = createPreviewClient({ ...base, connection: { ...base.connection, status: "live" }, offline: { ...base.offline, notice: warning } });
  const frame = document.createElement("main");
  document.body.append(frame);
  const root = createRoot(frame);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView spaceName="Team" features={{ sounds: false }} generatedAvatars={false} commandError="Camera blocked" />
        </ChalkProvider>,
      ),
    );
    const toasts = [...frame.querySelectorAll("[data-part=toast]")].map((t) => t.textContent);
    const button = frame.querySelector("[data-part=notice-button]")?.getAttribute("aria-label");
    console.log("OFFLINE_REPRO", JSON.stringify({ toasts, button }));
    expect(toasts).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    client.dispose();
    height.mockRestore();
  }
});

it.each(["replace", "remove"])("refits a folded notice when its large icon changes: %s", async (change) => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? 844 : 60;
  });
  const child = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.querySelector("[data-large-icon]") ? 80 : 48;
  });
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame);
  const fold = vi.fn();
  const render = (icon: ReactNode) => act(async () => root.render(<ToastStack toasts={[{ id: "same", message: "Camera permission needs attention", icon }]} onDismiss={() => {}} onFold={fold} />));
  try {
    await render(<span data-large-icon>Camera</span>);
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    await render(change === "replace" ? <span>Camera</span> : undefined);
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(1);
    expect(fold).toHaveBeenLastCalledWith([]);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    child.mockRestore();
  }
});

it("keeps the same mounted toast, focus and finite lifetime when its chrome changes", async () => {
  vi.useFakeTimers();
  const frame = document.createElement("main");
  document.body.append(frame);
  const root = createRoot(frame);
  const dismiss = vi.fn();
  const fold = vi.fn();
  const render = (icon: ReactNode, label: string) => act(async () => root.render(<ToastStack toasts={[{ id: "same", message: "Camera permission needs attention", duration: 1000, icon, action: { label, onClick: () => {} } }]} onDismiss={dismiss} onFold={fold} />));
  try {
    await render(<span>Camera</span>, "Retry");
    const toast = frame.querySelector("[data-part=toast]");
    const button = frame.querySelector("button");
    button?.focus();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await render(<span>Microphone</span>, "Try again");
    expect(frame.querySelector("[data-part=toast]")).toBe(toast);
    expect(frame.querySelector("button")).toBe(button);
    expect(document.activeElement).toBe(button);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(dismiss).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    vi.useRealTimers();
  }
});
