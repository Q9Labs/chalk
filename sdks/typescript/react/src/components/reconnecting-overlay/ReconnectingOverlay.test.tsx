// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECONNECTING_NOTICE_MS, ReconnectingOverlay, type ReconnectingOverlayProps } from "./ReconnectingOverlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReconnectingOverlay", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (props: ReconnectingOverlayProps) =>
    act(async () =>
      root.render(
        <>
          <button type="button">Mute</button>
          <ReconnectingOverlay {...props} />
        </>,
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

  it("waits two seconds, then keeps the same limbo for long interruptions", async () => {
    await render({ isVisible: true, status: "reconnecting" });
    await act(async () => vi.advanceTimersByTime(RECONNECTING_NOTICE_MS - 1));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Reconnecting…");
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Reconnecting…");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("lifts on recovery and restarts the grace period on the next drop", async () => {
    await render({ isVisible: true, status: "reconnecting" });
    await act(async () => vi.advanceTimersByTime(3_000));
    await render({ isVisible: false, status: "reconnecting" });
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render({ isVisible: true, status: "reconnecting" });
    await act(async () => vi.advanceTimersByTime(RECONNECTING_NOTICE_MS - 1));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Reconnecting…");
  });

  it("shows the status page for failed", async () => {
    await render({ isVisible: true, status: "failed" });
    expect(container.querySelector('[data-chalk-status="failed"] h1')?.textContent).toBe("Couldn’t connect to the call");
    expect(container.querySelector('[data-testid="reconnecting-notice"]')).toBeNull();
  });
});
