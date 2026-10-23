// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ToastStack } from "./ToastStack";

it("announces a shown rich message once as plain text without relying on a latched visual live region", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounts = 0;
  function Message() {
    useLayoutEffect(() => {
      mounts += 1;
    }, []);
    return <a href="#help">Camera help</a>;
  }
  const updates: string[] = [];
  const observer = new MutationObserver(() => updates.push(container.querySelector("[data-part=notice-announcer] [aria-live=assertive]")?.textContent ?? ""));
  const render = (text: string, icon = "Camera") => act(async () => root.render(<ToastStack toasts={[{ id: "same", message: <Message />, announcementText: text, type: "error", icon: <span>{icon}</span> }]} onDismiss={() => {}} onFold={() => {}} />));
  try {
    await render("Camera help");
    const announcer = container.querySelector("[data-part=notice-announcer]");
    if (!announcer) throw new Error("Missing notice announcer");
    expect(announcer.querySelector("[aria-live=assertive]")?.textContent).toBe("Camera help");
    expect(announcer.querySelector("a")).toBeNull();
    expect(container.querySelectorAll("[data-part=toast][aria-live], [data-part=toast][role]")).toHaveLength(0);
    observer.observe(announcer, { subtree: true, childList: true, characterData: true });
    await render("Camera help", "Microphone");
    expect(updates).toEqual([]);
    expect(mounts).toBe(1);
    await render("New camera failure");
    expect(announcer.querySelector("[aria-live=assertive]")?.textContent).toBe("New camera failure");
    expect(updates).toEqual(["New camera failure"]);
    expect(mounts).toBe(1);
  } finally {
    observer.disconnect();
    await act(async () => root.unmount());
    container.remove();
  }
});

it("announces an explicit new revision even when its speech text is identical", async () => {
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  const container = document.createElement("main");
  container.dataset.part = "call-frame";
  document.body.append(container);
  const root = createRoot(container);
  const render = (announcementKey: string) => act(async () => root.render(<ToastStack toasts={[{ id: "same", message: "Camera blocked", type: "error", announcementKey }]} onDismiss={() => {}} onFold={() => {}} />));
  try {
    await render("failure-one");
    const first = container.querySelector("[data-part=notice-announcer] [aria-live=assertive] > div");
    expect(first?.textContent).toBe("Camera blocked");
    await render("failure-two");
    const replacement = container.querySelector("[data-part=notice-announcer] [aria-live=assertive] > div");
    expect(replacement?.textContent).toBe("Camera blocked");
    expect(replacement).not.toBe(first);
    await render("failure-two");
    expect(container.querySelector("[data-part=notice-announcer] [aria-live=assertive] > div")).toBe(replacement);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    height.mockRestore();
  }
});

it("keeps speech available for an opaque visible message without announcementText", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  function Message() {
    return <span>Camera blocked</span>;
  }
  try {
    await act(async () => root.render(<ToastStack toasts={[{ id: "custom", message: <Message />, type: "error" }]} onDismiss={() => {}} />));
    expect(container.querySelector("[data-part=toast]")?.getAttribute("role")).toBe("alert");
    expect(container.querySelector("[data-part=toast]")?.getAttribute("aria-live")).toBe("assertive");
  } finally {
    await act(async () => root.unmount());
  }
});
