// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ToastStack, type Toast } from "./ToastStack";

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
  const root = createRoot(frame);
  const folds: (readonly string[])[] = [];
  return {
    frame,
    folds,
    render: (toasts: readonly Toast[]) => act(async () => root.render(<ToastStack toasts={toasts} onDismiss={() => undefined} onFold={(ids) => folds.push(ids)} />)),
    resize: (next: number) =>
      act(async () => {
        size = next;
        for (const notify of resizes) notify();
      }),
    shown: () => [...frame.querySelectorAll("[data-part='toast']")].map((toast) => toast.textContent),
    live: () => [...frame.querySelectorAll("[role='status'], [role='alert']")].map((region) => `${region.getAttribute("role")}: ${region.textContent}`),
    unmount: () => act(async () => root.unmount()),
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

it("shows the newest three in a call 620px tall, folds the rest, and mounts each message once", async () => {
  const mounts: string[] = [];
  function Message({ text }: { readonly text: string }) {
    useEffect(() => {
      mounts.push(text);
    }, [text]);
    return <>{text}</>;
  }
  const call = renderCall(620);
  await call.render(["Ana", "Ben", "Cy", "Di"].map((name) => ({ id: name, message: <Message text={`${name} joined`} /> })));
  expect(call.shown()).toEqual(["Ben joined", "Cy joined", "Di joined"]);
  expect(call.folds.at(-1)).toEqual(["Ana"]);
  expect(mounts.sort()).toEqual(["Ana joined", "Ben joined", "Cy joined", "Di joined"]);
  await call.unmount();
});

it("announces a folded notice once, politely for news and assertively for errors, and not again when it shows", async () => {
  const call = renderCall(320);
  await call.render([
    { id: "join", message: "Nora joined" },
    { id: "camera", message: "Camera blocked", type: "error" },
  ]);
  expect(call.live()).toEqual(["status: Nora joined", "alert: Camera blocked"]);
  await call.resize(844);
  expect(call.shown()).toEqual(["Nora joined", "Camera blocked"]);
  expect(call.live()).toEqual(["status: ", "alert: "]);
  await call.unmount();
});

it("doesn't announce a notice again when a newer one pushes it into the header", async () => {
  const call = renderCall(844);
  const people = ["Ana", "Ben", "Cy", "Di"].map((name) => ({ id: name, message: `${name} joined` }));
  await call.render(people.slice(0, 3));
  await call.render(people);
  expect(call.folds.at(-1)).toEqual(["Ana"]);
  expect(call.live()).toEqual(["status: Ben joined", "status: Cy joined", "status: Di joined", "status: ", "alert: "]);
  await call.unmount();
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
