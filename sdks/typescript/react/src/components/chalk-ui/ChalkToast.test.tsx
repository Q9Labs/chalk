// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkToast } from "./ChalkToast";

it("derives live-region attributes from the current announce prop in both directions", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (announce: boolean) => act(async () => root.render(<ChalkToast message="Camera blocked" type="error" announce={announce} onDismiss={() => {}} />));
  try {
    await render(true);
    const toast = container.querySelector("[data-part=toast]");
    expect(toast?.getAttribute("role")).toBe("alert");
    await render(false);
    expect(container.querySelector("[data-part=toast]")).toBe(toast);
    expect(toast?.hasAttribute("role")).toBe(false);
    expect(toast?.hasAttribute("aria-live")).toBe(false);
    expect(toast?.hasAttribute("aria-atomic")).toBe(false);
    await render(true);
    expect(toast?.getAttribute("role")).toBe("alert");
    expect(toast?.getAttribute("aria-live")).toBe("assertive");
    expect(toast?.getAttribute("aria-atomic")).toBe("true");
  } finally {
    await act(async () => root.unmount());
  }
});

it("turns off live-region attributes when announce changes to false", async () => {
  const frame = document.createElement("main");
  document.body.append(frame);
  const root = createRoot(frame);
  const render = (announce: boolean) => act(async () => root.render(<ChalkToast message="Camera blocked" duration={Infinity} announce={announce} onDismiss={() => {}} />));
  try {
    await render(true);
    expect(frame.querySelector("[data-part=toast]")?.getAttribute("aria-live")).toBe("polite");
    await render(false);
    const toast = frame.querySelector("[data-part=toast]");

    expect(toast?.getAttribute("aria-live")).toBeNull();
    expect(toast?.getAttribute("role")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    frame.remove();
  }
});

it("announces the next real message once after re-enabling announce", async () => {
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  const render = (announce: boolean, message: string) => act(async () => root.render(<ChalkToast type="error" message={message} announce={announce} onDismiss={() => {}} />));
  const mutations: string[] = [];
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList" || record.type === "characterData")) mutations.push(container.querySelector("[aria-live=assertive]")?.textContent ?? "silent");
  });
  try {
    await render(true, "First failure");
    await render(false, "Silent failure");
    expect(container.querySelector("[aria-live]")).toBeNull();
    await render(true, "Silent failure");
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    await render(true, "Next failure");
    await render(true, "Next failure");
    expect(container.querySelectorAll("[aria-live=assertive]")).toHaveLength(1);
    expect(mutations).toEqual(["Next failure"]);
  } finally {
    observer.disconnect();
    await act(async () => root.unmount());
    container.remove();
  }
});

it("fades info and success while warnings and errors wait for dismissal", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  const dismiss = vi.fn();
  try {
    await act(async () =>
      root.render(
        <>
          {(["info", "success", "warning", "error"] as const).map((type) => (
            <ChalkToast key={type} message={type} type={type} onDismiss={() => dismiss(type)} />
          ))}
        </>,
      ),
    );
    expect(container.querySelectorAll('[data-part="toast-dismiss"]')).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(5000));
    await act(async () => vi.advanceTimersByTime(160));
    expect(dismiss.mock.calls).toEqual([["info"], ["success"]]);
    expect(container.querySelector('[data-type="warning"]')?.getAttribute("data-exiting")).toBeNull();
    expect(container.querySelector('[data-type="error"]')?.getAttribute("data-exiting")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
