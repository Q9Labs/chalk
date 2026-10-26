// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { Chalk } from "./Chalk";

it("keeps the incoming request in the call notice stack and preserves both responses", async () => {
  const resizes = new Set<(entries: readonly ResizeObserverEntry[]) => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(readonly notify: (entries: readonly ResizeObserverEntry[]) => void) {}
      observe() {
        resizes.add(this.notify);
      }
      disconnect() {
        resizes.delete(this.notify);
      }
    },
  );
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1440);
  let bandHeight = 900;
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? 900 : bandHeight;
  });
  const noticeHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(50);
  const snapshot = createSnapshot([]);
  const request = { requestId: "request", kind: "unmute", actorParticipantId: "host", actorDisplayName: "Host", expiresAt: new Date(Date.now() + 60000).toISOString() } as const;
  const client = createPreviewClient({
    ...snapshot,
    connection: { ...snapshot.connection, status: "live", lastError: { code: "media.permission_denied", recoverable: true, message: "Camera blocked" }, episode: { id: "episode", startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 60000).toISOString() } },
    media: { ...snapshot.media, incomingRequests: [request] },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Chalk client={client} features={{ sounds: false }} />));
    const stack = container.querySelector('[data-part="toast-stack"]');
    const dialog = container.querySelector('[role="dialog"][aria-label="Unmute request"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.parentElement).toBe(stack);
    expect(container.querySelectorAll(".chalk-toasts")).toHaveLength(1);
    expect(stack?.textContent).toContain("1 minute left");
    expect(stack?.querySelector('[data-type="error"]')).not.toBeNull();
    bandHeight = 100;
    await act(async () => {
      for (const resize of [...resizes]) resize([]);
    });
    expect(stack?.querySelectorAll('[data-part="toast"]')).toHaveLength(2);
    expect(container.querySelector('[data-part="notice-button"]')?.getAttribute("aria-label")).toBe("Show 1 notice");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Not now")?.click());
    expect(client.getSnapshot().media.incomingRequests).toHaveLength(0);
    expect(client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
    await act(async () => client.updateSnapshot((current) => ({ ...current, media: { ...current.media, incomingRequests: [request] } })));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Allow")?.click());
    expect(client.getSnapshot().media.incomingRequests).toHaveLength(0);
    expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
  } finally {
    await act(async () => root.unmount());
    client.dispose();
    container.remove();
    width.mockRestore();
    height.mockRestore();
    noticeHeight.mockRestore();
    vi.unstubAllGlobals();
  }
});
