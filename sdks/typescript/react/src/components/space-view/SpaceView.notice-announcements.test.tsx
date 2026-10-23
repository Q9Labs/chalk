// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { SpaceView } from "./SpaceView";

it("announces a new external commandError after rotation, through the real SpaceView", async () => {
  let height = 844;
  let resize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly notify: () => void;
      constructor(notify: () => void) {
        this.notify = notify;
      }
      observe(target: HTMLElement) {
        if (target.dataset.part === "call-frame") resize = this.notify;
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const snapshot = createSnapshot([]);
  const client = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (commandError: string) =>
    act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} commandError={commandError} />
        </ChalkProvider>,
      ),
    );
  try {
    await render("Camera is blocked");
    const frame = container.querySelector<HTMLElement>('[data-part="call-frame"]');
    if (!frame) throw new Error("No frame");
    Object.defineProperty(frame, "clientHeight", { get: () => height });
    expect(frame.querySelector('[role="alert"]')?.textContent).toContain("Camera is blocked");
    await act(async () => {
      height = 320;
      resize();
    });
    expect(frame.querySelector('[data-part="notice-button"]')?.getAttribute("aria-label")).toBe("Show 1 notice");
    await render("Screen sharing was denied");
    expect(frame.querySelector('[data-part="notice-announcer"] [aria-live="assertive"]')?.textContent).toContain("Screen sharing was denied");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
    vi.unstubAllGlobals();
  }
});
