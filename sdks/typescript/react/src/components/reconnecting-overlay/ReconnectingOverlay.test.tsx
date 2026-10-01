// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkinProvider } from "../skin-context";
import { RECONNECTING_NOTICE_MS, ReconnectingOverlay, type ReconnectingOverlayProps } from "./ReconnectingOverlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["classic", "chalk"] as const)("ReconnectingOverlay in the %s skin", (skin) => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (props: ReconnectingOverlayProps) =>
    act(async () =>
      root.render(
        <SkinProvider skin={skin}>
          <button type="button">Mute</button>
          <ReconnectingOverlay {...props} />
        </SkinProvider>,
      ),
    );

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows a non-blocking status notice for the first 10 seconds", async () => {
    await render({ isVisible: true, status: "reconnecting" });
    await act(async () => vi.advanceTimersByTime(RECONNECTING_NOTICE_MS - 1));
    const notice = container.querySelector('[data-testid="reconnecting-notice"]');
    expect(notice?.textContent).toBe("Reconnecting…");
    expect(notice?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("does not block pointer events or take focus", async () => {
    await render({ isVisible: true, status: "reconnecting" });
    const notice = container.querySelector('[data-testid="reconnecting-notice"]');
    expect(notice?.className).toContain("pointer-events-none");
    expect(notice?.parentElement?.className).toContain("pointer-events-none");
    expect(notice?.hasAttribute("tabindex")).toBe(false);
    expect(container.querySelector("button")?.textContent).toBe("Mute");
    expect(document.activeElement).toBe(document.body);
  });

  it("switches to the Reconnecting modal at 10 seconds", async () => {
    await render({ isVisible: true, status: "reconnecting" });
    await act(async () => vi.advanceTimersByTime(RECONNECTING_NOTICE_MS));
    expect(container.querySelector('[data-testid="reconnecting-notice"]')).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(container.querySelector("#connection-status-title")?.textContent).toBe("Reconnecting");
  });

  it("removes the notice when the connection is live again and restarts the timer on the next drop", async () => {
    await render({ isVisible: true, status: "reconnecting" });
    await act(async () => vi.advanceTimersByTime(5_000));
    await render({ isVisible: false, status: "reconnecting" });
    expect(container.querySelector('[data-testid="reconnecting-notice"]')).toBeNull();
    await render({ isVisible: true, status: "reconnecting" });
    await act(async () => vi.advanceTimersByTime(7_000));
    expect(container.querySelector('[data-testid="reconnecting-notice"]')).not.toBeNull();
  });

  it("keeps the failure dialog for failed", async () => {
    await render({ isVisible: true, status: "failed" });
    expect(container.querySelector("#connection-status-title")?.textContent).toBe("Connection Failed");
    expect(container.querySelector('[data-testid="reconnecting-notice"]')).toBeNull();
  });
});
