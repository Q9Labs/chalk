// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { ToastStack } from "./ToastStack";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { SpaceView } from "../space-view/SpaceView";

it("keeps an expired warning reachable and dismissed through Notices and rotation", async () => {
  let callHeight = 320;
  const callbacks = new Set<(entries: ResizeObserverEntry[]) => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private notify: (entries: ResizeObserverEntry[]) => void) {}
      observe() {
        callbacks.add(this.notify);
      }
      disconnect() {
        callbacks.delete(this.notify);
      }
    },
  );
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => callHeight);
  const base = createSnapshot([]);
  const warning = "Your expired offline actions were not sent. Actions are kept for up to 24 hours.";
  const client = createPreviewClient({ ...base, connection: { ...base.connection, status: "live" }, offline: { ...base.offline, notice: warning } });
  const frame = document.createElement("main");
  document.body.append(frame);
  const root = createRoot(frame);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} commandError="Camera blocked" />
        </ChalkProvider>,
      ),
    );
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    expect(frame.querySelector("[data-part=notice-button]")?.getAttribute("aria-label")).toBe("Show 2 notices");
    await act(async () => frame.querySelector<HTMLButtonElement>("[data-part=notice-button]")!.click());
    const notice = [...document.querySelectorAll("[data-part=notice]")].find((node) => node.textContent?.includes(warning));
    expect(notice).toBeDefined();
    expect(document.querySelectorAll("[data-part=notice]")).toHaveLength(2);
    await act(async () => notice!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(frame.querySelector("[data-part=notice-button]")?.getAttribute("aria-label")).toBe("Show 1 notice");
    expect([...document.querySelectorAll("[data-part=notice]")].some((node) => node.textContent?.includes(warning))).toBe(false);
    await act(async () => {
      callHeight = 844;
      for (const callback of [...callbacks]) callback([]);
    });
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(1);
    expect(frame.querySelector("[data-part=toast]")?.textContent).not.toContain(warning);
    await act(async () => {
      callHeight = 320;
      for (const callback of [...callbacks]) callback([]);
    });
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    expect(frame.querySelector("[data-part=notice-button]")?.getAttribute("aria-label")).toBe("Show 1 notice");
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    client.dispose();
    height.mockRestore();
    vi.unstubAllGlobals();
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
