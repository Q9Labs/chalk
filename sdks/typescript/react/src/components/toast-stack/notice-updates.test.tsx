// @vitest-environment happy-dom
import { act, useEffect, useState, type ReactNode } from "react";
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

it("does not remount a folded rich toast for equivalent new JSX icons", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? 844 : 60;
  });
  const child = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame),
    mounted = vi.fn(),
    unmounted = vi.fn();
  function Message() {
    useEffect(() => {
      mounted();
      return () => {
        unmounted();
      };
    }, []);
    return <input />;
  }
  function Icon() {
    return <svg aria-hidden="true" />;
  }
  const fold = () => {};
  const render = () => act(async () => root.render(<ToastStack toasts={[{ id: "same", message: <Message />, announcementText: "Camera blocked", icon: <Icon /> }]} onDismiss={() => {}} onFold={fold} />));
  try {
    await render();
    const initialMounts = mounted.mock.calls.length;
    const initialUnmounts = unmounted.mock.calls.length;
    for (let i = 0; i < 3; i++) await render();

    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    expect(mounted).toHaveBeenCalledTimes(initialMounts);
    expect(unmounted).toHaveBeenCalledTimes(initialUnmounts);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    child.mockRestore();
  }
});

it("refits fresh action and icon elements without looping, remounting rich input, or restarting expiry", async () => {
  vi.useFakeTimers();
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? 844 : 200;
  });
  const child = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(48);
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame);
  const mount = vi.fn(),
    dismiss = vi.fn();
  let renders = 0;
  function Message() {
    useEffect(() => {
      mount();
    }, []);
    return <input aria-label="Draft" defaultValue="" />;
  }
  function Host({ version }: { version: number }) {
    const [, setFolded] = useState<readonly string[]>([]);
    if (++renders > 100) throw new Error("Fit invalidation loops");
    return <ToastStack toasts={[{ id: "stable", message: <Message />, announcementText: "Camera blocked", duration: 1000, icon: <span>{version}</span>, action: { label: `Retry ${version}`, onClick() {} } }]} onDismiss={dismiss} onFold={(ids) => setFolded([...ids])} />;
  }
  const render = (version: number) => act(async () => root.render(<Host version={version} />));
  try {
    await render(0);
    const input = frame.querySelector("input")!;
    input.value = "keep this draft";
    input.focus();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(input.parentElement!, { subtree: true, childList: true, characterData: true });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    for (let version = 1; version <= 15; version++) await render(version);
    expect(mount).toHaveBeenCalledOnce();
    expect(frame.querySelector("input")).toBe(input);
    expect(input.value).toBe("keep this draft");
    expect(document.activeElement).toBe(input);
    expect([...mutations, ...observer.takeRecords()]).toEqual([]);
    observer.disconnect();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(dismiss).toHaveBeenCalledOnce();
    expect(renders).toBeLessThan(100);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    child.mockRestore();
    vi.useRealTimers();
  }
});
