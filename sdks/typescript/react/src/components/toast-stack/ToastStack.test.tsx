// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientFailure } from "@q9labsai/chalk-client";
import { ToastStack, type Toast, type ToastStackProps } from "./ToastStack";
import { mediaFailureToast } from "./call-events";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A call frame of the given height. happy-dom does no layout, so the test sets the height and plays each resize. */
function renderCall(height: number) {
  let size = height;
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  Object.defineProperty(frame, "clientHeight", { configurable: true, get: () => size });
  document.body.append(frame);
  const resizes = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly #notify: () => void;
      constructor(notify: () => void) {
        this.#notify = notify;
      }
      observe() {
        resizes.add(this.#notify);
      }
      unobserve() {}
      disconnect() {
        resizes.delete(this.#notify);
      }
    },
  );
  const updates: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (target?.closest("[data-part=notice-announcer]")) updates.push(target.textContent ?? "");
    }
  });
  observer.observe(frame, { subtree: true, childList: true, characterData: true });
  const root = createRoot(frame);
  const folds: (readonly string[])[] = [];
  const reportFold = (ids: readonly string[]) => folds.push(ids);
  return {
    frame,
    folds,
    updates,
    render: (toasts: readonly Toast[], options: Partial<Pick<ToastStackProps, "onFold" | "onDismiss" | "maxVisible">> = { onFold: reportFold }) =>
      act(async () => root.render(<ToastStack toasts={toasts} onDismiss={options.onDismiss ?? (() => undefined)} onFold={options.onFold} maxVisible={options.maxVisible} />)),
    resize: (next: number) =>
      act(async () => {
        size = next;
        for (const notify of resizes) notify();
      }),
    shown: () => [...frame.querySelectorAll("[data-part='toast']")].map((toast) => toast.textContent),
    live: () => [...frame.querySelectorAll("[aria-live]")].map((region) => `${region.getAttribute("aria-live")}: ${region.textContent}`),
    unmount: () =>
      act(async () => {
        root.unmount();
        observer.disconnect();
      }),
  };
}

it("folds every notice, by its whole id, in a call shorter than 620px", async () => {
  const call = renderCall(619);
  await call.render([
    { id: "network error", message: "You're offline", type: "error" },
    { id: "join", message: "Nora joined" },
  ]);
  expect(call.shown()).toEqual([]);
  expect(call.folds.at(-1)).toEqual(["network error", "join"]);
  await call.unmount();
});

it("announces rich folded notices as text without mounting caller code or hidden controls", async () => {
  const mounted = vi.fn();
  function Message() {
    useEffect(mounted, []);
    return <a href="https://example.com/help">Camera help</a>;
  }
  const call = renderCall(320);
  try {
    await call.render([{ id: "rich", message: <Message />, announcementText: "Camera help", type: "error" }]);
    expect(mounted).not.toHaveBeenCalled();
    expect(call.frame.querySelector("[data-part='notice-announcer'] a")).toBeNull();
    expect(call.live()).toContain("assertive: Camera help");
  } finally {
    await call.unmount();
  }
});

it("clears a disabled fold callback and initializes its replacement with unchanged folded IDs", async () => {
  const call = renderCall(320);
  const first = vi.fn();
  const second = vi.fn();
  const toasts: Toast[] = [{ id: "error", message: "Camera blocked", type: "error" }];
  try {
    await call.render(toasts, { onFold: first });
    expect(first).toHaveBeenLastCalledWith(["error"]);
    await call.render(toasts, { onFold: second });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenLastCalledWith(["error"]);
    await call.render(toasts, {});
    expect(second).toHaveBeenLastCalledWith([]);
    expect(call.shown()).toEqual(["Camera blocked"]);
    await call.render(toasts, { onFold: second });
    expect(second).toHaveBeenLastCalledWith(["error"]);
  } finally {
    await call.unmount();
  }
  expect(second).toHaveBeenLastCalledWith([]);
});

it("keeps a rich stable-ID toast mounted, focused and on its original expiry across parent renders", async () => {
  vi.useFakeTimers();
  const call = renderCall(844);
  const mounted = vi.fn();
  const dismissed = vi.fn();
  function Message() {
    useEffect(mounted, []);
    return <button>Open chat</button>;
  }
  const render = () => call.render([{ id: "rich", message: <Message />, duration: 1000 }], { onFold: () => undefined, onDismiss: dismissed });
  try {
    await render();
    const button = call.frame.querySelector("button");
    button?.focus();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await render();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(call.frame.querySelector("button")).toBe(button);
    expect(document.activeElement).toBe(button);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(dismissed).toHaveBeenCalledOnce();
  } finally {
    await call.unmount();
    vi.useRealTimers();
  }
});

it("shows the newest three in a call 620px tall and announces folded rich messages without mounting them", async () => {
  const mounts: string[] = [];
  function Message({ text }: { readonly text: string }) {
    useEffect(() => {
      mounts.push(text);
    }, [text]);
    return <>{text}</>;
  }
  const call = renderCall(620);
  await call.render(["Ana", "Ben", "Cy", "Di"].map((name) => ({ id: name, message: <Message text={`${name} joined`} />, announcementText: `${name} joined` })));
  expect(call.shown()).toEqual(["Ben joined", "Cy joined", "Di joined"]);
  expect(call.folds.at(-1)).toEqual(["Ana"]);
  expect(mounts.sort()).toEqual(["Ben joined", "Cy joined", "Di joined"]);
  expect(call.live()).toEqual(["polite: Ana joinedBen joinedCy joinedDi joined", "assertive: "]);
  await call.unmount();
});

it("announces a folded notice once, politely for news and assertively for errors, and not again when it shows or folds again", async () => {
  const call = renderCall(320);
  await call.render([
    { id: "join", message: "Nora joined" },
    { id: "camera", message: "Camera blocked", type: "error" },
  ]);
  expect(call.live()).toEqual(["polite: Nora joined", "assertive: Camera blocked"]);
  call.updates.length = 0;
  await call.resize(844);
  expect(call.shown()).toEqual(["Nora joined", "Camera blocked"]);
  expect(call.updates).toEqual([]);
  await call.resize(320);
  expect(call.updates).toEqual([]);
  await call.unmount();
});

it("doesn't announce a notice again when a newer one pushes it into the header", async () => {
  const call = renderCall(844);
  const people = ["Ana", "Ben", "Cy", "Di"].map((name) => ({ id: name, message: `${name} joined` }));
  await call.render(people.slice(0, 3));
  await call.render(people);
  expect(call.folds.at(-1)).toEqual(["Ana"]);
  expect(call.live()).toEqual(["polite: Di joined", "assertive: "]);
  expect(call.shown()).toEqual(["Ben joined", "Cy joined", "Di joined"]);
  // Speech has one owner; the rich visual toasts have no implicit live roles.
  expect(call.frame.querySelectorAll("[data-part=toast][aria-live], [data-part=toast][role]")).toHaveLength(0);
  await call.unmount();
});

it("announces a replacement after a previously folded notice returns to the stage, but not when it folds again", async () => {
  const call = renderCall(844);
  const first: Toast = { id: "command-error", message: "Camera is blocked", type: "error" };
  const replacement: Toast = { ...first, message: "Screen sharing was denied" };
  try {
    await call.render([first]);
    call.updates.length = 0;
    await call.resize(320);
    await call.resize(844);
    expect(call.updates).toEqual([]);
    await call.render([replacement]);
    expect(call.live()).toContain("assertive: Screen sharing was denied");
    call.updates.length = 0;
    await call.resize(320);
    await call.render([{ ...replacement }]);
    expect(call.updates).toEqual([]);
  } finally {
    await call.unmount();
  }
});

it("preserves focus and stays quiet when an unchanged typed media failure is remapped", async () => {
  const call = renderCall(844);
  const toast = (code: ClientFailure["code"] = "media.permission_denied"): Toast => {
    const failure = mediaFailureToast({ code, recoverable: true, message: "denied" }, "camera");
    if (!failure) throw new Error("Missing media failure toast");
    return { id: "space-command-error", ...failure };
  };
  try {
    await call.render([toast()]);
    const dismiss = call.frame.querySelector<HTMLButtonElement>("[data-part='toast-dismiss']");
    if (!dismiss) throw new Error("Missing Dismiss button");
    dismiss.focus();
    call.updates.length = 0;
    await call.render([toast()]);
    expect(document.activeElement).toBe(dismiss);
    await call.resize(320);
    await call.render([toast()]);
    expect(call.updates).toEqual([]);
    await call.render([toast("media.device_not_found")]);
    expect(call.live().some((message) => message.includes("assertive: No camera found."))).toBe(true);
  } finally {
    await call.unmount();
  }
});

it("shows the newest notice where ResizeObserver doesn't exist, as in jsdom tests and server rendering", async () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ToastStack
          toasts={[
            { id: "a", message: "Nora joined" },
            { id: "b", message: "Malik joined" },
          ]}
          onDismiss={() => undefined}
        />,
      ),
    );
    const shown = [...container.querySelectorAll("[data-part='toast-stack'] [data-part='toast']")].map((toast) => toast.textContent);
    expect(shown.at(-1)).toBe("Malik joined");
    expect(container.querySelectorAll(".chalk-toasts")).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
});
