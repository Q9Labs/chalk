// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientFailure } from "@q9labsai/chalk-client";
import { ToastStack, type Toast } from "./ToastStack";
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
    live: () => [...frame.querySelectorAll("[aria-live]")].map((region) => `${region.getAttribute("aria-live")}: ${region.textContent}`),
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

it("announces a folded notice once, politely for news and assertively for errors, and not again when it shows or folds again", async () => {
  const call = renderCall(320);
  await call.render([
    { id: "join", message: "Nora joined" },
    { id: "camera", message: "Camera blocked", type: "error" },
  ]);
  expect(call.live()).toEqual(["polite: Nora joined", "assertive: Camera blocked"]);
  await call.resize(844);
  expect(call.shown()).toEqual(["Nora joined", "Camera blocked"]);
  expect(call.live()).toEqual(["polite: ", "assertive: "]);
  await call.resize(320);
  expect(call.live()).toEqual(["polite: ", "assertive: "]);
  await call.unmount();
});

it("doesn't announce a notice again when a newer one pushes it into the header", async () => {
  const call = renderCall(844);
  const people = ["Ana", "Ben", "Cy", "Di"].map((name) => ({ id: name, message: `${name} joined` }));
  await call.render(people.slice(0, 3));
  await call.render(people);
  expect(call.folds.at(-1)).toEqual(["Ana"]);
  expect(call.live()).toEqual(["polite: Ben joined", "polite: Cy joined", "polite: Di joined", "polite: ", "assertive: "]);
  // The announcer leaves the status and alert roles to toasts, so a host's query for a toast by role finds only toasts.
  expect([...call.frame.querySelectorAll("[role='status'], [role='alert']")].map((toast) => toast.textContent)).toEqual(["Ben joined", "Cy joined", "Di joined"]);
  await call.unmount();
});

it("announces a replacement after a previously folded notice returns to the stage, but not when it folds again", async () => {
  const call = renderCall(844);
  const first: Toast = { id: "command-error", message: "Camera is blocked", type: "error" };
  const replacement: Toast = { ...first, message: "Screen sharing was denied" };
  try {
    await call.render([first]);
    await call.resize(320);
    await call.resize(844);
    expect(call.live()).toEqual(["polite: ", "assertive: "]);
    await call.render([replacement]);
    expect(call.live()).toContain("assertive: Screen sharing was denied");
    await call.resize(320);
    await call.render([{ ...replacement }]);
    expect(call.live()).toEqual(["polite: ", "assertive: "]);
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
    await call.render([toast()]);
    expect(document.activeElement).toBe(dismiss);
    await call.resize(320);
    await call.render([toast()]);
    expect(call.live()).toEqual(["polite: ", "assertive: "]);
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
